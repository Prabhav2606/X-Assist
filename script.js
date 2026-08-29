let activeUserId = null;
let activeUserName = "";
let authMode = 'signin';
let speechRecognition = null;
let isListening = false;
let speechBaseText = '';
let finalSpeechTranscript = '';
let shouldIgnoreSpeechResults = false;
let speechErrorMessage = '';
let speechStatusTimer = null;
let activeConversationId = null;
let conversations = [];
let conversationSidebarOpen = false;
let isCreatingConversation = false;
let isSendingMessage = false;
const PASSWORD_REVEAL_DURATION = 400;
const passwordInputStates = new WeakMap();

function getFirstName(name) {
    const nameParts = String(name || '').trim().split(/\s+/);
    return nameParts[0] || 'there';
}

function sortConversations() {
    conversations.sort((first, second) => Number(second.updated_at || 0) - Number(first.updated_at || 0));
}

function setConversationStatus(message = '') {
    const status = document.getElementById('conversationSidebarStatus');
    if (status) status.textContent = message;
}

function getActiveConversation() {
    return conversations.find((conversation) => conversation.id === activeConversationId) || null;
}

function updateActiveConversationTitle() {
    const title = getActiveConversation()?.title || 'New chat';
    const titleElement = document.getElementById('activeConversationTitle');
    if (titleElement) titleElement.textContent = title;
}

function renderConversationList() {
    const list = document.getElementById('conversationList');
    if (!list) return;

    list.replaceChildren();

    if (!conversations.length) {
        const emptyState = document.createElement('p');
        emptyState.className = 'conversation-list-empty';
        emptyState.textContent = 'No conversations yet.';
        list.appendChild(emptyState);
        updateActiveConversationTitle();
        return;
    }

    conversations.forEach((conversation) => {
        const button = document.createElement('button');
        const title = document.createElement('span');
        const isActive = conversation.id === activeConversationId;

        button.type = 'button';
        button.className = `conversation-item${isActive ? ' is-active' : ''}`;
        button.title = conversation.title;
        button.setAttribute('aria-current', isActive ? 'page' : 'false');
        button.addEventListener('click', () => selectConversation(conversation.id));

        title.className = 'conversation-item-title';
        title.textContent = conversation.title;
        button.appendChild(title);
        list.appendChild(button);
    });

    updateActiveConversationTitle();
}

function upsertConversation(conversation) {
    if (!conversation?.id) return;

    const conversationIndex = conversations.findIndex((item) => item.id === conversation.id);
    if (conversationIndex === -1) {
        conversations.push(conversation);
    } else {
        conversations[conversationIndex] = conversation;
    }

    sortConversations();
    renderConversationList();
}

function isCompactSidebar() {
    return window.matchMedia('(max-width: 760px)').matches;
}

function setConversationSidebarOpen(shouldOpen) {
    conversationSidebarOpen = Boolean(shouldOpen);

    const chatApp = document.getElementById('chatApp');
    const sidebar = document.getElementById('conversationSidebar');
    const toggle = document.getElementById('conversationSidebarToggle');

    if (chatApp) chatApp.classList.toggle('is-sidebar-open', conversationSidebarOpen);
    if (sidebar) sidebar.setAttribute('aria-hidden', String(!conversationSidebarOpen));
    if (toggle) {
        const label = conversationSidebarOpen ? 'Close conversations' : 'Open conversations';
        toggle.setAttribute('aria-expanded', String(conversationSidebarOpen));
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }
}

function toggleConversationSidebar() {
    setConversationSidebarOpen(!conversationSidebarOpen);
}

async function loadConversations() {
    if (!activeUserId) return [];

    const response = await fetch(`/api/conversations?user_id=${encodeURIComponent(activeUserId)}`);
    const data = await response.json();
    if (!response.ok || data.error) {
        throw new Error(data.error || 'Failed to load conversations.');
    }

    conversations = Array.isArray(data.conversations) ? data.conversations : [];
    sortConversations();
    renderConversationList();
    setConversationStatus('');
    return conversations;
}

async function initializeConversations() {
    const signedInUserId = activeUserId;

    try {
        const loadedConversations = await loadConversations();
        if (activeUserId !== signedInUserId) return;

        if (!loadedConversations.length) {
            await createNewChat();
            return;
        }

        await selectConversation(loadedConversations[0].id, false);
    } catch (error) {
        console.error('Failed to initialize conversations', error);
        setConversationStatus('Unable to load your conversations. Please try again.');
    }
}

async function createNewChat() {
    if (!activeUserId || isCreatingConversation) return;

    const requestedUserId = activeUserId;
    const newChatButton = document.getElementById('newChatBtn');
    isCreatingConversation = true;
    if (newChatButton) newChatButton.disabled = true;
    setConversationStatus('');

    try {
        const response = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: requestedUserId })
        });
        const data = await response.json();
        if (!response.ok || data.error || !data.conversation) {
            throw new Error(data.error || 'Failed to create a new chat.');
        }
        if (activeUserId !== requestedUserId) return;

        activeConversationId = data.conversation.id;
        upsertConversation(data.conversation);
        await loadUserHistory(activeConversationId);

        if (isCompactSidebar()) {
            setConversationSidebarOpen(false);
        }
    } catch (error) {
        console.error('Failed to create a new chat', error);
        setConversationStatus('Unable to create a new chat. Please try again.');
    } finally {
        isCreatingConversation = false;
        if (newChatButton) newChatButton.disabled = false;
    }
}

async function selectConversation(conversationId, closeCompactSidebar = true) {
    if (!conversationId || !activeUserId) return;

    stopSpeechRecognition(true);
    activeConversationId = conversationId;
    renderConversationList();
    setConversationStatus('');

    if (closeCompactSidebar && isCompactSidebar()) {
        setConversationSidebarOpen(false);
    }

    await loadUserHistory(conversationId);
}

function getPasswordInputState(input) {
    let state = passwordInputStates.get(input);

    if (!state) {
        state = {
            value: input.value,
            isVisible: input.type === 'text',
            isTemporarilyRevealed: false,
            revealTimer: null,
            selectionStart: input.selectionStart ?? input.value.length
        };
        passwordInputStates.set(input, state);
    }

    return state;
}

function clearPasswordRevealTimer(state) {
    if (state.revealTimer) {
        window.clearTimeout(state.revealTimer);
        state.revealTimer = null;
    }
}

function syncPasswordInputState(input, state) {
    if (!state.isTemporarilyRevealed) {
        state.value = input.value;
    }
}

function setPasswordCaret(input, position) {
    const caretPosition = Math.max(0, Math.min(position, input.value.length));
    if (document.activeElement === input) {
        input.setSelectionRange(caretPosition, caretPosition);
    }
}

function restorePasswordMask(input, state = getPasswordInputState(input)) {
    clearPasswordRevealTimer(state);
    if (state.isVisible) return;

    state.isTemporarilyRevealed = false;
    input.type = 'password';
    input.value = state.value;
    setPasswordCaret(input, state.selectionStart);
}

function revealLastPasswordCharacter(input, state, revealIndex, caretPosition) {
    clearPasswordRevealTimer(state);

    if (state.isVisible || !state.value) return;

    const characterIndex = Math.max(0, Math.min(revealIndex, state.value.length - 1));
    const maskedValue = '\u2022'.repeat(state.value.length);

    state.isTemporarilyRevealed = true;
    state.selectionStart = caretPosition;
    input.type = 'text';
    input.value = `${maskedValue.slice(0, characterIndex)}${state.value.charAt(characterIndex)}${maskedValue.slice(characterIndex + 1)}`;
    setPasswordCaret(input, caretPosition);

    state.revealTimer = window.setTimeout(() => {
        restorePasswordMask(input, state);
    }, PASSWORD_REVEAL_DURATION);
}

function getPasswordInputValue(input) {
    const state = getPasswordInputState(input);
    syncPasswordInputState(input, state);
    return state.value;
}

function clearPasswordInput(input) {
    const state = getPasswordInputState(input);

    clearPasswordRevealTimer(state);
    state.value = '';
    state.isVisible = false;
    state.isTemporarilyRevealed = false;
    state.selectionStart = 0;
    input.type = 'password';
    input.value = '';
}

function hidePasswordInput(input) {
    const state = getPasswordInputState(input);
    syncPasswordInputState(input, state);

    state.isVisible = false;
    restorePasswordMask(input, state);
}

function notifyPasswordEdited(input) {
    if (input.id === 'deletePassword') {
        clearDeletePasswordError();
    }
}

function handlePasswordInput(event) {
    const input = event.currentTarget;
    const state = getPasswordInputState(input);

    if (state.isTemporarilyRevealed && !state.isVisible) return;

    state.value = input.value;
    state.selectionStart = input.selectionStart ?? state.value.length;

    if (state.isVisible || !event.inputType?.startsWith('insert') || !state.value) return;

    revealLastPasswordCharacter(input, state, state.selectionStart - 1, state.selectionStart);
}

function handlePasswordBeforeInput(event) {
    const input = event.currentTarget;
    const state = getPasswordInputState(input);

    if (!state.isTemporarilyRevealed || state.isVisible) return;

    const inputType = event.inputType;
    const selectionStart = input.selectionStart ?? state.selectionStart;
    const selectionEnd = input.selectionEnd ?? selectionStart;

    if (inputType.startsWith('insert')) {
        const insertedText = event.data;

        // Fall back to native masking for input methods that do not expose their text.
        if (!insertedText) {
            restorePasswordMask(input, state);
            return;
        }

        event.preventDefault();
        state.value = `${state.value.slice(0, selectionStart)}${insertedText}${state.value.slice(selectionEnd)}`;
        state.selectionStart = selectionStart + insertedText.length;
        revealLastPasswordCharacter(input, state, state.selectionStart - 1, state.selectionStart);
        notifyPasswordEdited(input);
        return;
    }

    let nextValue = state.value;
    let nextSelectionStart = selectionStart;

    if (inputType === 'deleteContentBackward') {
        if (selectionStart !== selectionEnd) {
            nextValue = `${state.value.slice(0, selectionStart)}${state.value.slice(selectionEnd)}`;
        } else if (selectionStart > 0) {
            nextValue = `${state.value.slice(0, selectionStart - 1)}${state.value.slice(selectionStart)}`;
            nextSelectionStart -= 1;
        }
    } else if (inputType === 'deleteContentForward') {
        nextValue = `${state.value.slice(0, selectionStart)}${state.value.slice(selectionEnd === selectionStart ? selectionStart + 1 : selectionEnd)}`;
    } else if (inputType === 'deleteByCut' || inputType === 'deleteByDrag') {
        nextValue = `${state.value.slice(0, selectionStart)}${state.value.slice(selectionEnd)}`;
    } else {
        restorePasswordMask(input, state);
        return;
    }

    event.preventDefault();
    state.value = nextValue;
    state.selectionStart = nextSelectionStart;
    restorePasswordMask(input, state);
    notifyPasswordEdited(input);
}

function initializePasswordCharacterReveal() {
    document.querySelectorAll('#password, #deletePassword').forEach((input) => {
        getPasswordInputState(input);
        input.addEventListener('beforeinput', handlePasswordBeforeInput);
        input.addEventListener('input', handlePasswordInput);
    });
}

function getSpeechRecognitionConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
}

function setSpeechStatus(message, isError = false) {
    const status = document.getElementById('speechStatus');
    if (!status) return;

    if (speechStatusTimer) {
        window.clearTimeout(speechStatusTimer);
        speechStatusTimer = null;
    }

    status.textContent = message;
    status.classList.toggle('is-error', isError);

    // Keep the live listening state visible, but clear completed states after four seconds.
    if (message && !isListening) {
        const displayedMessage = message;
        speechStatusTimer = window.setTimeout(() => {
            if (!isListening && status.textContent === displayedMessage) {
                status.textContent = '';
                status.classList.toggle('is-error', false);
            }
            speechStatusTimer = null;
        }, 4000);
    }
}

function updateSpeechButton() {
    const button = document.getElementById('speechBtn');
    if (!button) return;

    button.classList.toggle('is-listening', isListening);
    button.setAttribute('aria-pressed', String(isListening));
    button.setAttribute('aria-label', isListening ? 'Stop voice input' : 'Start voice input');
    button.title = isListening ? 'Stop voice input' : 'Start voice input';
}

function initializeSpeechRecognition() {
    const button = document.getElementById('speechBtn');
    const SpeechRecognition = getSpeechRecognitionConstructor();

    if (!button || !SpeechRecognition) {
        if (button) {
            button.disabled = true;
            button.setAttribute('aria-label', 'Voice input is unavailable in this browser');
            button.title = 'Voice input requires a supported browser';
        }
        setSpeechStatus('Voice input is unavailable in this browser.', true);
        return;
    }

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;
    speechRecognition.lang = navigator.language || 'en-US';

    speechRecognition.onstart = () => {
        isListening = true;
        shouldIgnoreSpeechResults = false;
        speechErrorMessage = '';
        updateSpeechButton();
        setSpeechStatus('Listening...');
    };

    speechRecognition.onresult = (event) => {
        if (shouldIgnoreSpeechResults) return;

        let interimTranscript = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const transcript = event.results[index][0].transcript;
            if (event.results[index].isFinal) {
                finalSpeechTranscript += `${transcript} `;
            } else {
                interimTranscript += transcript;
            }
        }

        const input = document.getElementById('userInput');
        input.value = [speechBaseText, finalSpeechTranscript, interimTranscript]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(' ');
        input.focus();
    };

    speechRecognition.onerror = (event) => {
        if (event.error === 'aborted') return;

        const errorMessages = {
            'not-allowed': 'Microphone permission was denied. Allow it in your browser and try again.',
            'service-not-allowed': 'Speech recognition is unavailable. Check your browser microphone settings.',
            'audio-capture': 'No microphone was found. Connect one and try again.',
            'network': 'Speech recognition could not reach the service. Check your connection.',
            'no-speech': 'I did not hear anything. Try speaking again.'
        };

        speechErrorMessage = errorMessages[event.error] || 'Voice input stopped unexpectedly. Please try again.';
        isListening = false;
        updateSpeechButton();
        setSpeechStatus(speechErrorMessage, true);
    };

    speechRecognition.onend = () => {
        isListening = false;
        updateSpeechButton();

        if (shouldIgnoreSpeechResults) {
            shouldIgnoreSpeechResults = false;
            setSpeechStatus('');
            return;
        }

        if (!speechErrorMessage) {
            const message = finalSpeechTranscript.trim()
                ? 'Voice input added to your message.'
                : 'Voice input stopped.';
            setSpeechStatus(message);
        }

        document.getElementById('userInput').focus();
    };
}

function stopSpeechRecognition(discardPendingResults = false) {
    if (!speechRecognition || !isListening) return;

    shouldIgnoreSpeechResults = discardPendingResults;
    isListening = false;
    updateSpeechButton();

    if (discardPendingResults) {
        speechRecognition.abort();
    } else {
        speechRecognition.stop();
    }
}

function toggleSpeechRecognition() {
    if (!speechRecognition) {
        initializeSpeechRecognition();
    }

    if (!speechRecognition) {
        setSpeechStatus('Voice input is unavailable in this browser.', true);
        return;
    }

    if (isListening) {
        setSpeechStatus('Finishing voice input...');
        stopSpeechRecognition();
        return;
    }

    const input = document.getElementById('userInput');
    speechBaseText = input.value.trim();
    finalSpeechTranscript = '';
    shouldIgnoreSpeechResults = false;
    speechErrorMessage = '';

    try {
        speechRecognition.start();
    } catch (error) {
        isListening = false;
        updateSpeechButton();
        setSpeechStatus('Voice input is still closing. Please try again in a moment.', true);
    }
}

function showMessage(msg, isError = true) {
    const errDiv = document.getElementById('authError');
    const succDiv = document.getElementById('authSuccess');
    if (isError) {
        errDiv.innerText = msg; errDiv.style.display = 'block'; succDiv.style.display = 'none';
    }
    else {
        succDiv.innerText = msg; succDiv.style.display = 'block'; errDiv.style.display = 'none';
    }
}

function hideMessages() {
    document.getElementById('authError').style.display = 'none';
    document.getElementById('authSuccess').style.display = 'none';
}

function toggleMode() {
    hideMessages();
    const title = document.getElementById('authTitle');
    const primaryBtn = document.getElementById('primaryAuthBtn');
    const secondaryBtn = document.getElementById('secondaryAuthBtn');
    const nameInput = document.getElementById('name');

    // Reset password visibility automatically
    const pwdInput = document.getElementById('password');
    const eyeOpen = document.getElementById('eyeOpen');
    const eyeClosed = document.getElementById('eyeClosed');
    hidePasswordInput(pwdInput);
    eyeOpen.style.display = 'block';
    eyeClosed.style.display = 'none';

    if (authMode === 'signin') {
        authMode = 'signup';
        title.innerText = 'Sign Up';
        primaryBtn.innerText = 'Sign Up';
        primaryBtn.onclick = signUp;
        secondaryBtn.innerText = 'Back to Sign In';
        nameInput.style.display = 'block'; // Show name field
    } else {
        authMode = 'signin';
        title.innerText = 'Sign In';
        primaryBtn.innerText = 'Sign In';
        primaryBtn.onclick = signIn;
        secondaryBtn.innerText = 'Create an Account';
        nameInput.style.display = 'none'; // Hide name field
    }
}

function updatePasswordToggleIcon(eyeOpenId, eyeClosedId, toggleId, isVisible) {
    const eyeOpen = document.getElementById(eyeOpenId);
    const eyeClosed = document.getElementById(eyeClosedId);
    const toggle = toggleId ? document.getElementById(toggleId) : null;

    eyeOpen.style.display = isVisible ? 'none' : 'block';
    eyeClosed.style.display = isVisible ? 'block' : 'none';

    if (toggle) {
        const label = isVisible ? 'Hide password' : 'Show password';
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('aria-pressed', String(isVisible));
        toggle.title = label;
    }
}

function togglePasswordField(inputId, eyeOpenId, eyeClosedId, toggleId) {
    const pwdInput = document.getElementById(inputId);
    const state = getPasswordInputState(pwdInput);
    syncPasswordInputState(pwdInput, state);

    if (!state.isVisible) {
        restorePasswordMask(pwdInput, state);
        state.isVisible = true;
        pwdInput.type = 'text';
        pwdInput.value = state.value;
        updatePasswordToggleIcon(eyeOpenId, eyeClosedId, toggleId, true);
    } else {
        hidePasswordInput(pwdInput);
        updatePasswordToggleIcon(eyeOpenId, eyeClosedId, toggleId, false);
    }
}

function togglePassword() {
    togglePasswordField('password', 'eyeOpen', 'eyeClosed');
}

function toggleDeletePassword() {
    togglePasswordField('deletePassword', 'deleteEyeOpen', 'deleteEyeClosed', 'deletePasswordToggle');
}

function resetDeletePasswordField() {
    clearPasswordInput(document.getElementById('deletePassword'));
    updatePasswordToggleIcon('deleteEyeOpen', 'deleteEyeClosed', 'deletePasswordToggle', false);
}

async function signUp() {
    hideMessages();
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = getPasswordInputValue(document.getElementById('password')).trim();
        
    if (!name) return showMessage("Please enter your name.");
    else if (!email) return showMessage("Please enter your email address.");
    else if (!password) return showMessage("Please enter your password.");

    const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    
    if (data.error) {
        showMessage(data.error);
    }
    else {
        showAccountCreatedModal();
    }
}

async function signIn() {
    hideMessages();
    const email = document.getElementById('email').value.trim();
    const password = getPasswordInputValue(document.getElementById('password')).trim();
        
    if (!email && !password) return showMessage("Please enter your email address and password.");
    else if (!email) return showMessage("Please enter your email address.");
    else if (!password) return showMessage("Please enter your password.");

    const res = await fetch('/api/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    
    if (data.error) {
        showMessage(data.error);
    }
    else {
        activeUserId = data.user_id;
        activeUserName = data.name;
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('chatApp').style.display = 'flex';
        document.getElementById('headerUserName').innerText = data.name;
        
        document.getElementById('name').value = '';
        document.getElementById('email').value = '';
        clearPasswordInput(document.getElementById('password'));
        
        initializeConversations();
    }
}

function deleteAccount() {
    // Show the model and clear out any old text
    document.getElementById('deleteModel').style.display = 'flex';
    resetDeletePasswordField();
    clearDeletePasswordError();
}

function closeDeleteModel() {
    // Hide the model
    document.getElementById('deleteModel').style.display = 'none';
    resetDeletePasswordField();
    clearDeletePasswordError();
}

function closeModalOnBackdrop(event) {
    if (event.target !== event.currentTarget) return;

    const modalId = event.currentTarget.id;
    if (modalId === 'deleteModel') {
        closeDeleteModel();
    } else if (modalId === 'clearChatModal') {
        closeClearChatModal();
    } else if (modalId === 'signOutModal') {
        closeSignOutModal();
    }
}

function showDeletePasswordError(message, isInvalidPassword = false) {
    const passwordInput = document.getElementById('deletePassword');
    const errorMessage = document.getElementById('deletePasswordError');

    errorMessage.textContent = message;
    errorMessage.classList.toggle('is-invalid', isInvalidPassword);
    passwordInput.classList.toggle('is-invalid', isInvalidPassword);
}

function clearDeletePasswordError() {
    const passwordInput = document.getElementById('deletePassword');
    const errorMessage = document.getElementById('deletePasswordError');

    errorMessage.textContent = '';
    errorMessage.classList.remove('is-invalid');
    passwordInput.classList.remove('is-invalid');
}

async function confirmDeleteAccount() {
    const password = getPasswordInputValue(document.getElementById('deletePassword')).trim();
    
    if (!password) {
        showDeletePasswordError('Please enter your password to confirm.');
        return;
    }

    try {
        // Send both the user ID and the password to the backend
        const res = await fetch('/api/delete_account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                user_id: activeUserId,
                password: password
            })
        });
            
        const data = await res.json();
        
        if (data.status === 'deleted') {
            closeDeleteModel();
            showAccountDeletedModal();
        } else {
            const backendMessage = data.error || 'Failed to delete account.';
            const isIncorrectPassword = res.status === 401 || backendMessage.toLowerCase() === 'incorrect password!';
            const message = isIncorrectPassword ? 'Incorrect password!' : backendMessage;
            showDeletePasswordError(message, isIncorrectPassword);
        }
    }
    catch (err) {
        showDeletePasswordError('Failed to connect to server. Please try again.');
        console.error(err);
    }
}

function signOut() {
    document.getElementById('signOutModal').style.display = 'flex';
}

function closeSignOutModal() {
    document.getElementById('signOutModal').style.display = 'none';
}

function confirmSignOut() {
    closeSignOutModal();
    performSignOut();
}

function showAccountCreatedModal() {
    document.getElementById('accountCreatedModal').style.display = 'flex';
    document.getElementById('accountCreatedOkBtn').focus();
}

function confirmAccountCreationOnBackdrop(event) {
    if (event.target === event.currentTarget) {
        confirmAccountCreation();
    }
}

function confirmAccountCreation() {
    document.getElementById('accountCreatedModal').style.display = 'none';
    document.getElementById('name').value = '';
    document.getElementById('email').value = '';
    clearPasswordInput(document.getElementById('password'));

    if (authMode === 'signup') {
        toggleMode();
    }
}

function showAccountDeletedModal() {
    document.getElementById('accountDeletedModal').style.display = 'flex';
    document.getElementById('accountDeletedOkBtn').focus();
}

function confirmAccountDeletion() {
    document.getElementById('accountDeletedModal').style.display = 'none';
    performSignOut();
}

function replayWelcomeAnimation() {
    const welcomeTitle = document.querySelector('.welcome-title');
    if (!welcomeTitle) return;

    // Reset the completed keyframe animation before showing the auth screen again.
    welcomeTitle.classList.remove('is-writing');
    void welcomeTitle.offsetWidth;
    welcomeTitle.classList.add('is-writing');
}

function performSignOut() {
    stopSpeechRecognition(true);

    // 2. Clear the active session and its conversation state.
    activeUserId = null;
    activeUserName = '';
    activeConversationId = null;
    conversations = [];
    isCreatingConversation = false;
    isSendingMessage = false;
    setConversationSidebarOpen(false);
    renderConversationList();
    setConversationStatus('');
    document.getElementById('chatBox').replaceChildren();
    document.getElementById('headerUserName').textContent = 'Loading...';
    
    // 3. Flip the screens back
    document.getElementById('chatApp').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    replayWelcomeAnimation();

    // 4. Clear the input fields so the old password doesn't sit there
    document.getElementById('name').value = '';
    document.getElementById('email').value = '';

    // 5. Force the password field back to hidden (Reset the eye icons)
    const pwdInput = document.getElementById('password');
    const eyeOpen = document.getElementById('eyeOpen');
    const eyeClosed = document.getElementById('eyeClosed');
        
    clearPasswordInput(pwdInput);
    eyeOpen.style.display = 'block';
    eyeClosed.style.display = 'none';
    
    // 6. Hide any lingering error messages or popups.
    hideMessages();
}

async function loadUserHistory(conversationId = activeConversationId) {
    if (!activeUserId || !conversationId) return;

    const requestedUserId = activeUserId;
    const chatBox = document.getElementById('chatBox');
    chatBox.replaceChildren();

    try {
        const response = await fetch(`/api/history?user_id=${encodeURIComponent(requestedUserId)}&conversation_id=${encodeURIComponent(conversationId)}`);
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to load this conversation.');
        }
        if (activeUserId !== requestedUserId || activeConversationId !== conversationId) {
            return;
        }

        data.history?.forEach((message) => {
            appendMessage(message.content[0].text, message.role);
        });
    }
    catch (error) {
        console.error('Failed to load history', error);
        if (activeUserId === requestedUserId && activeConversationId === conversationId) {
            setConversationStatus('Unable to load this conversation. Please try again.');
        }
    }
}

function clearChat() {
    if (!activeConversationId) return;
    document.getElementById('clearChatModal').style.display = 'flex';
}

function closeClearChatModal() {
    document.getElementById('clearChatModal').style.display = 'none';
}

async function confirmClearChat() {
    closeClearChatModal();
    if (!activeConversationId) return;

    const conversationId = activeConversationId;

    try {
        const response = await fetch('/api/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: activeUserId, conversation_id: conversationId })
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to clear this conversation.');
        }

        upsertConversation(data.conversation);
        if (activeConversationId === conversationId) {
            await loadUserHistory(conversationId);
        }
    } catch (error) {
        console.error('Failed to clear conversation', error);
        setConversationStatus('Unable to clear this conversation. Please try again.');
    }
}

async function sendMessage() {
    stopSpeechRecognition(true);

    const inputElement = document.getElementById('userInput');
    const messageText = inputElement.value.trim();

    if (!messageText || isSendingMessage) return;

    if (!activeConversationId) {
        await createNewChat();
        if (!activeConversationId) return;
    }

    const conversationId = activeConversationId;
    const chatBox = document.getElementById('chatBox');
    isSendingMessage = true;

    appendMessage(messageText, 'user');
    inputElement.value = '';
    const loadingDiv = appendMessage('Thinking...', 'assistant');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: messageText,
                user_id: activeUserId,
                conversation_id: conversationId
            })
        });
        const data = await response.json();
        if (data.conversation) {
            upsertConversation(data.conversation);
        }
        if (activeConversationId !== conversationId) return;

        loadingDiv.innerText = data.reply || `Error: ${data.error || 'Failed to get response'}`;
    }
    catch (error) {
        if (activeConversationId === conversationId) {
            loadingDiv.innerText = 'Error connecting to server.';
        }
    } finally {
        isSendingMessage = false;
    }

    if (activeConversationId === conversationId) {
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

function appendMessage(text, role) {

    const chatBox = document.getElementById('chatBox');
    const msgDiv = document.createElement('div');

    msgDiv.className = `message ${role}`;
    msgDiv.innerText = text;

    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    return msgDiv;

}

document.addEventListener('DOMContentLoaded', () => {
    initializePasswordCharacterReveal();

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && conversationSidebarOpen) {
            setConversationSidebarOpen(false);
        }
    });
});
initializeSpeechRecognition();
