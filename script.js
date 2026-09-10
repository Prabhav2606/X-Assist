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
let isStartingSpeechRecognition = false;
let activeConversationId = null;
let conversations = [];
const conversationHistoryCache = new Map();
let conversationSidebarOpen = false;
let headerMenuOpen = false;
let isCreatingConversation = false;
let isLoadingConversations = false;
let conversationPendingDeletionId = null;
let isDeletingConversation = false;
let conversationContextMenuId = null;
let conversationPendingRenameId = null;
let isRenamingConversation = false;
let conversationLongPressTimer = null;
let conversationLongPressOrigin = null;
let suppressConversationClickUntil = 0;
let isSendingMessage = false;
let isTemporaryChat = false;
let lastSavedConversationId = null;
let temporaryChatTouchFeedbackTimer = null;
const PASSWORD_REVEAL_DURATION = 400;
const DELETE_CONVERSATION_TITLE_LIMIT = 36;
const CONVERSATION_TITLE_MAX_LENGTH = 80;
const CONVERSATION_LONG_PRESS_DELAY = 550;
const CONVERSATION_LONG_PRESS_MOVE_TOLERANCE = 12;
const TEMPORARY_CONVERSATION_ID = '__temporary_chat__';
const TEMPORARY_CONTEXT_MESSAGE_LIMIT = 5;
const TEMPORARY_CHAT_TOUCH_FEEDBACK_DURATION = 300;
const passwordInputStates = new WeakMap();

function getFirstName(name) {
    const nameParts = String(name || '').trim().split(/\s+/);
    return nameParts[0] || 'there';
}

function sortConversations() {
    conversations.sort((first, second) => {
        const pinDifference = Number(Boolean(second.is_pinned)) - Number(Boolean(first.is_pinned));
        if (pinDifference) return pinDifference;
        return Number(second.updated_at || 0) - Number(first.updated_at || 0);
    });
}

function setConversationStatus(message = '') {
    const status = document.getElementById('conversationSidebarStatus');
    if (status) status.textContent = message;
}

function getActiveConversation() {
    return conversations.find((conversation) => conversation.id === activeConversationId) || null;
}

function normalizeHistoryMessage(message) {
    return {
        role: message?.role === 'user' ? 'user' : 'assistant',
        content: [{ text: String(message?.content?.[0]?.text || '') }]
    };
}

function cacheConversationHistory(conversationId, history) {
    if (!conversationId) return [];

    const normalizedHistory = Array.isArray(history)
        ? history.map(normalizeHistoryMessage)
        : [];
    conversationHistoryCache.set(conversationId, normalizedHistory);
    return normalizedHistory;
}

function appendCachedMessage(conversationId, text, role) {
    const history = conversationHistoryCache.get(conversationId) || [];
    history.push(normalizeHistoryMessage({ role, content: [{ text }] }));
    conversationHistoryCache.set(conversationId, history);
    return history;
}

function renderConversationHistory(history) {
    const chatBox = document.getElementById('chatBox');
    chatBox.replaceChildren();

    history.forEach((message) => {
        appendMessage(message.content[0].text, message.role);
    });
}

function updateActiveConversationTitle() {
    const title = isTemporaryChat ? 'Temporary chat' : getActiveConversation()?.title || 'New chat';
    const titleElement = document.getElementById('activeConversationTitle');
    if (titleElement) titleElement.textContent = title;
}

function updateTemporaryChatToggle() {
    const toggle = document.getElementById('temporaryChatToggle');
    if (!toggle) return;

    const label = isTemporaryChat ? 'End temporary chat' : 'Start temporary chat';
    toggle.classList.toggle('is-active', isTemporaryChat);
    toggle.disabled = isSendingMessage;
    toggle.setAttribute('aria-pressed', String(isTemporaryChat));
    toggle.setAttribute('aria-label', label);
    toggle.title = isTemporaryChat
        ? 'Temporary chat is on. Click to return to saved chats'
        : 'Start temporary chat';
}

function showTemporaryChatTouchFeedback() {
    const toggle = document.getElementById('temporaryChatToggle');
    const usesTouchPrimaryPointer = window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
    if (!toggle || !usesTouchPrimaryPointer) return;
    const keepActiveColor = isTemporaryChat;

    if (temporaryChatTouchFeedbackTimer) {
        window.clearTimeout(temporaryChatTouchFeedbackTimer);
    }

    toggle.classList.add('is-touch-activating');
    toggle.classList.toggle('is-touch-active-feedback', keepActiveColor);
    temporaryChatTouchFeedbackTimer = window.setTimeout(() => {
        toggle.classList.remove('is-touch-activating');
        toggle.classList.remove('is-touch-active-feedback');
        temporaryChatTouchFeedbackTimer = null;
    }, TEMPORARY_CHAT_TOUCH_FEEDBACK_DURATION);
}

function getTemporaryGreeting() {
    return `Hello ${getFirstName(activeUserName)}! How can I help you today?`;
}

function getTemporaryHistoryForRequest() {
    const history = conversationHistoryCache.get(TEMPORARY_CONVERSATION_ID) || [];
    return history.slice(-(TEMPORARY_CONTEXT_MESSAGE_LIMIT - 1));
}

function startTemporaryChat() {
    if (!activeUserId || isSendingMessage) return;

    stopSpeechRecognition(true);
    if (!isTemporaryChat && activeConversationId) {
        lastSavedConversationId = activeConversationId;
    }

    isTemporaryChat = true;
    activeConversationId = TEMPORARY_CONVERSATION_ID;
    const history = cacheConversationHistory(TEMPORARY_CONVERSATION_ID, [
        {
            role: 'assistant',
            content: [{ text: getTemporaryGreeting() }]
        }
    ]);

    setConversationStatus('');
    renderConversationList();
    renderConversationHistory(history);
    updateTemporaryChatToggle();

    if (isCompactSidebar()) {
        setConversationSidebarOpen(false);
    }
}

async function endTemporaryChat() {
    if (!isTemporaryChat || isSendingMessage) return;

    stopSpeechRecognition(true);
    isTemporaryChat = false;
    conversationHistoryCache.delete(TEMPORARY_CONVERSATION_ID);

    const savedConversation = conversations.find((conversation) => conversation.id === lastSavedConversationId)
        || conversations[0]
        || null;
    activeConversationId = savedConversation?.id || null;
    setConversationStatus('');
    renderConversationList();
    updateTemporaryChatToggle();

    if (savedConversation) {
        lastSavedConversationId = savedConversation.id;
        await loadUserHistory(savedConversation.id);
    } else {
        await createNewChat();
    }
}

async function toggleTemporaryChat() {
    if (isSendingMessage) return;

    showTemporaryChatTouchFeedback();
    if (isTemporaryChat) {
        await endTemporaryChat();
    } else {
        startTemporaryChat();
    }
}

function getConversationById(conversationId) {
    return conversations.find((conversation) => conversation.id === conversationId) || null;
}

function clearConversationLongPress() {
    if (conversationLongPressTimer) {
        window.clearTimeout(conversationLongPressTimer);
        conversationLongPressTimer = null;
    }
    conversationLongPressOrigin = null;
}

function closeConversationContextMenu() {
    clearConversationLongPress();
    conversationContextMenuId = null;

    const menu = document.getElementById('conversationContextMenu');
    if (!menu) return;

    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
        item.tabIndex = -1;
    });
}

function openConversationContextMenu(conversationId, clientX, clientY, shouldFocus = false) {
    const conversation = getConversationById(conversationId);
    const menu = document.getElementById('conversationContextMenu');
    if (!conversation || !menu) return;

    clearConversationLongPress();
    setHeaderMenuOpen(false);
    conversationContextMenuId = conversationId;

    const pinLabel = conversation.is_pinned ? 'Unpin' : 'Pin';
    const pinAction = document.getElementById('conversationPinAction');
    const pinLabelElement = document.getElementById('conversationPinActionLabel');
    if (pinAction) pinAction.setAttribute('aria-label', `${pinLabel} conversation: ${conversation.title}`);
    if (pinLabelElement) pinLabelElement.textContent = pinLabel;

    menu.classList.add('is-open');
    menu.setAttribute('aria-hidden', 'false');
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
        item.tabIndex = 0;
    });

    const menuBounds = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - menuBounds.width - viewportPadding);
    const maxTop = Math.max(viewportPadding, window.innerHeight - menuBounds.height - viewportPadding);
    menu.style.left = `${Math.min(Math.max(viewportPadding, clientX), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(viewportPadding, clientY), maxTop)}px`;

    if (shouldFocus) {
        menu.querySelector('[role="menuitem"]')?.focus();
    }
}

function startConversationLongPress(event, conversationId) {
    if (event.pointerType === 'mouse') return;

    clearConversationLongPress();
    conversationLongPressOrigin = {
        conversationId,
        clientX: event.clientX,
        clientY: event.clientY
    };
    conversationLongPressTimer = window.setTimeout(() => {
        const origin = conversationLongPressOrigin;
        conversationLongPressTimer = null;
        if (!origin) return;

        suppressConversationClickUntil = Date.now() + 750;
        openConversationContextMenu(origin.conversationId, origin.clientX, origin.clientY);
        if (navigator.vibrate) navigator.vibrate(8);
    }, CONVERSATION_LONG_PRESS_DELAY);
}

function cancelConversationLongPressOnMove(event) {
    if (!conversationLongPressOrigin) return;

    const horizontalDistance = event.clientX - conversationLongPressOrigin.clientX;
    const verticalDistance = event.clientY - conversationLongPressOrigin.clientY;
    if (Math.hypot(horizontalDistance, verticalDistance) > CONVERSATION_LONG_PRESS_MOVE_TOLERANCE) {
        clearConversationLongPress();
    }
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
        const item = document.createElement('div');
        const button = document.createElement('button');
        const title = document.createElement('span');
        const isActive = conversation.id === activeConversationId;

        item.className = `conversation-list-item${isActive ? ' is-active' : ''}`;
        button.type = 'button';
        button.className = 'conversation-item';
        button.title = conversation.title;
        button.setAttribute('aria-current', isActive ? 'page' : 'false');
        button.addEventListener('click', (event) => {
            if (Date.now() < suppressConversationClickUntil) {
                event.preventDefault();
                return;
            }
            selectConversation(conversation.id);
        });
        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            openConversationContextMenu(conversation.id, event.clientX, event.clientY);
        });
        button.addEventListener('pointerdown', (event) => startConversationLongPress(event, conversation.id));
        button.addEventListener('pointermove', cancelConversationLongPressOnMove);
        button.addEventListener('pointerup', clearConversationLongPress);
        button.addEventListener('pointercancel', clearConversationLongPress);
        button.addEventListener('pointerleave', clearConversationLongPress);
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;

            event.preventDefault();
            const bounds = button.getBoundingClientRect();
            openConversationContextMenu(
                conversation.id,
                bounds.left + Math.min(bounds.width / 2, 36),
                bounds.top + Math.min(bounds.height / 2, 24),
                true
            );
        });

        title.className = 'conversation-item-title';
        title.textContent = conversation.title;
        button.appendChild(title);

        if (conversation.is_pinned) {
            const pinIndicator = document.createElement('span');
            pinIndicator.className = 'conversation-pin-indicator';
            pinIndicator.setAttribute('aria-hidden', 'true');
            pinIndicator.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m8 3 8 0-1 6 3 3H6l3-3-1-6Z"></path>
                    <path d="M12 15v6"></path>
                </svg>`;
            button.appendChild(pinIndicator);
        }

        item.appendChild(button);
        list.appendChild(item);
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

async function updateConversationMetadata(conversationId, updates) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: activeUserId, ...updates })
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.conversation) {
        throw new Error(data.error || 'Failed to update this conversation.');
    }
    return data.conversation;
}

async function toggleSelectedConversationPin() {
    const conversation = getConversationById(conversationContextMenuId);
    closeConversationContextMenu();
    if (!conversation) return;

    const requestedUserId = activeUserId;
    try {
        const updatedConversation = await updateConversationMetadata(conversation.id, {
            is_pinned: !conversation.is_pinned
        });
        if (activeUserId !== requestedUserId) return;
        upsertConversation(updatedConversation);
    } catch (error) {
        console.error('Failed to update conversation pin', error);
        setConversationStatus(error.message || 'Unable to update this conversation.');
    }
}

function showRenameConversationError(message = '') {
    const errorMessage = document.getElementById('renameConversationError');
    if (errorMessage) errorMessage.textContent = message;
}

function clearRenameConversationError() {
    showRenameConversationError();
}

function openRenameConversationModal() {
    const conversation = getConversationById(conversationContextMenuId);
    closeConversationContextMenu();
    if (!conversation) return;

    conversationPendingRenameId = conversation.id;
    const input = document.getElementById('renameConversationInput');
    input.value = conversation.title;
    clearRenameConversationError();
    document.getElementById('renameConversationModal').style.display = 'flex';
    window.setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

function closeRenameConversationModal() {
    if (isRenamingConversation) return;

    conversationPendingRenameId = null;
    clearRenameConversationError();
    document.getElementById('renameConversationModal').style.display = 'none';
}

async function confirmRenameConversation() {
    const conversationId = conversationPendingRenameId;
    const input = document.getElementById('renameConversationInput');
    const confirmButton = document.getElementById('renameConversationConfirmBtn');
    const title = input.value.replace(/\s+/g, ' ').trim();

    if (!conversationId || isRenamingConversation) return;
    if (!title) {
        showRenameConversationError('Enter a conversation title.');
        input.focus();
        return;
    }
    if (title.length > CONVERSATION_TITLE_MAX_LENGTH) {
        showRenameConversationError(`Conversation titles can be up to ${CONVERSATION_TITLE_MAX_LENGTH} characters.`);
        input.focus();
        return;
    }

    const requestedUserId = activeUserId;
    const originalButtonLabel = confirmButton?.textContent;
    isRenamingConversation = true;
    if (confirmButton) {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Saving...';
    }
    clearRenameConversationError();

    try {
        const updatedConversation = await updateConversationMetadata(conversationId, { title });
        if (activeUserId !== requestedUserId) return;

        upsertConversation(updatedConversation);
        conversationPendingRenameId = null;
        document.getElementById('renameConversationModal').style.display = 'none';
    } catch (error) {
        console.error('Failed to rename conversation', error);
        showRenameConversationError(error.message || 'Unable to rename this conversation.');
    } finally {
        isRenamingConversation = false;
        if (confirmButton) {
            confirmButton.disabled = false;
            confirmButton.textContent = originalButtonLabel;
        }
    }
}

function deleteSelectedConversation() {
    const conversationId = conversationContextMenuId;
    closeConversationContextMenu();
    if (conversationId) openDeleteConversationModal(conversationId);
}

function isCompactSidebar() {
    return window.matchMedia('(max-width: 760px)').matches;
}

function setConversationSidebarOpen(shouldOpen) {
    conversationSidebarOpen = Boolean(shouldOpen);
    closeConversationContextMenu();
    if (conversationSidebarOpen) {
        setHeaderMenuOpen(false);
    }

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

function setHeaderMenuOpen(shouldOpen) {
    headerMenuOpen = Boolean(shouldOpen);
    if (headerMenuOpen) closeConversationContextMenu();

    const menu = document.getElementById('headerActionsMenu');
    const toggle = document.getElementById('headerMenuToggle');
    if (menu) {
        menu.classList.toggle('is-open', headerMenuOpen);
        menu.setAttribute('aria-hidden', String(!headerMenuOpen));
        menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
            item.tabIndex = headerMenuOpen ? 0 : -1;
        });
    }
    if (toggle) {
        const label = headerMenuOpen ? 'Close chat actions' : 'Open chat actions';
        toggle.setAttribute('aria-expanded', String(headerMenuOpen));
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }
}

function toggleHeaderMenu() {
    setHeaderMenuOpen(!headerMenuOpen);
}

async function loadConversations(includeActiveHistory = false) {
    if (!activeUserId) return null;

    const query = new URLSearchParams({ user_id: activeUserId });
    if (includeActiveHistory) query.set('include_active_history', 'true');

    const response = await fetch(`/api/conversations?${query.toString()}`);
    const data = await response.json();
    if (!response.ok || data.error) {
        throw new Error(data.error || 'Failed to load conversations.');
    }

    conversations = Array.isArray(data.conversations) ? data.conversations : [];
    sortConversations();
    setConversationStatus('');
    return data;
}

async function initializeConversations() {
    const signedInUserId = activeUserId;
    const newChatButton = document.getElementById('newChatBtn');
    isTemporaryChat = false;
    lastSavedConversationId = null;
    conversationHistoryCache.delete(TEMPORARY_CONVERSATION_ID);
    updateTemporaryChatToggle();
    isLoadingConversations = true;
    if (newChatButton) newChatButton.disabled = true;

    try {
        const data = await loadConversations(true);
        if (activeUserId !== signedInUserId) return;

        if (!conversations.length) {
            isLoadingConversations = false;
            if (newChatButton) newChatButton.disabled = false;
            await createNewChat();
            return;
        }

        const activeConversation = data.active_conversation || conversations[0];
        activeConversationId = activeConversation.id;
        lastSavedConversationId = activeConversation.id;
        renderConversationList();

        if (data.active_conversation?.id === activeConversation.id && Array.isArray(data.history)) {
            renderConversationHistory(cacheConversationHistory(activeConversation.id, data.history));
        } else {
            await loadUserHistory(activeConversation.id);
        }
    } catch (error) {
        console.error('Failed to initialize conversations', error);
        setConversationStatus('Unable to load your conversations. Please try again.');
    } finally {
        if (activeUserId === signedInUserId) {
            isLoadingConversations = false;
            if (newChatButton) newChatButton.disabled = false;
        }
    }
}

async function createNewChat() {
    if (!activeUserId || isCreatingConversation || isLoadingConversations) return;

    const requestedUserId = activeUserId;
    const newChatButton = document.getElementById('newChatBtn');
    const wasTemporaryChat = isTemporaryChat;
    if (wasTemporaryChat) stopSpeechRecognition(true);

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

        if (wasTemporaryChat) {
            isTemporaryChat = false;
            conversationHistoryCache.delete(TEMPORARY_CONVERSATION_ID);
            updateTemporaryChatToggle();
        }
        activeConversationId = data.conversation.id;
        lastSavedConversationId = activeConversationId;
        upsertConversation(data.conversation);
        if (Array.isArray(data.history)) {
            renderConversationHistory(cacheConversationHistory(activeConversationId, data.history));
        } else {
            await loadUserHistory(activeConversationId, true);
        }

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
    closeConversationContextMenu();
    if (isTemporaryChat) {
        isTemporaryChat = false;
        conversationHistoryCache.delete(TEMPORARY_CONVERSATION_ID);
        updateTemporaryChatToggle();
    }
    activeConversationId = conversationId;
    lastSavedConversationId = conversationId;
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
    if (message && !isListening && !isStartingSpeechRecognition) {
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

function scrollMessageInputToEnd(input = document.getElementById('userInput')) {
    if (!input) return;

    const caretPosition = input.value.length;
    input.setSelectionRange(caretPosition, caretPosition);
    input.scrollLeft = input.scrollWidth;

    // Some mobile browsers apply their own input scroll after focus completes.
    window.requestAnimationFrame(() => {
        input.scrollLeft = input.scrollWidth;
    });
}

function focusMessageInputAtEnd(input = document.getElementById('userInput')) {
    if (!input) return;

    input.focus({ preventScroll: true });
    scrollMessageInputToEnd(input);
}

function updateSpeechButton() {
    const button = document.getElementById('speechBtn');
    if (!button) return;

    button.classList.toggle('is-listening', isListening);
    button.classList.toggle('is-requesting', isStartingSpeechRecognition);
    button.setAttribute('aria-pressed', String(isListening));
    button.setAttribute('aria-busy', String(isStartingSpeechRecognition));

    const label = isStartingSpeechRecognition
        ? 'Starting voice input'
        : isListening
            ? 'Stop voice input'
            : 'Start voice input';
    button.setAttribute('aria-label', label);
    button.title = label;
}

function getSpeechUnavailableMessage() {
    if (!window.isSecureContext) {
        return 'Voice input requires an HTTPS connection. Open the secure version of this site and try again.';
    }

    return 'Voice input is not supported in this browser. Try Chrome or use your keyboard\'s dictation.';
}

function getSpeechStartErrorMessage(error) {
    const errorMessages = {
        NotAllowedError: 'Microphone permission was denied. Allow microphone access in your browser settings and try again.',
        SecurityError: 'Voice input requires an HTTPS connection. Open the secure version of this site and try again.',
        InvalidStateError: 'Voice input is still closing. Please try again in a moment.'
    };

    return errorMessages[error?.name] || 'Voice input could not start. Please try again.';
}

function initializeSpeechRecognition(showUnavailableMessage = false) {
    const button = document.getElementById('speechBtn');
    const SpeechRecognition = getSpeechRecognitionConstructor();

    if (!button || !SpeechRecognition) {
        if (button) {
            button.disabled = false;
            button.setAttribute('aria-label', 'Voice input is unavailable in this browser');
            button.title = 'Voice input requires a supported browser';
        }
        if (showUnavailableMessage) {
            setSpeechStatus(getSpeechUnavailableMessage(), true);
        }
        return false;
    }

    if (speechRecognition) return true;

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;
    speechRecognition.lang = navigator.language || 'en-US';

    speechRecognition.onstart = () => {
        isStartingSpeechRecognition = false;
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
        focusMessageInputAtEnd(input);
    };

    speechRecognition.onerror = (event) => {
        isStartingSpeechRecognition = false;
        if (event.error === 'aborted') return;

        const errorMessages = {
            'not-allowed': 'Microphone permission was denied. Allow it in your browser and try again.',
            'service-not-allowed': 'Speech recognition is unavailable. Check your browser microphone settings.',
            'audio-capture': 'No microphone was found. Connect one and try again.',
            'network': 'Speech recognition could not reach the service. Check your connection.',
            'no-speech': 'I did not hear anything. Try speaking again.',
            'language-not-supported': 'Voice input is unavailable for this language in your browser.',
            'language-unavailable': 'Voice input is temporarily unavailable. Please try again.'
        };

        speechErrorMessage = errorMessages[event.error] || 'Voice input stopped unexpectedly. Please try again.';
        isListening = false;
        updateSpeechButton();
        setSpeechStatus(speechErrorMessage, true);
    };

    speechRecognition.onend = () => {
        isStartingSpeechRecognition = false;
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

        focusMessageInputAtEnd();
    };

    return true;
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
    const input = document.getElementById('userInput');

    if (isListening) {
        setSpeechStatus('Finishing voice input...');
        scrollMessageInputToEnd(input);
        stopSpeechRecognition();
        return;
    }

    if (isStartingSpeechRecognition) return;

    if (!speechRecognition && !initializeSpeechRecognition(true)) {
        return;
    }

    speechBaseText = input.value.trim();
    finalSpeechTranscript = '';
    shouldIgnoreSpeechResults = false;
    speechErrorMessage = '';
    scrollMessageInputToEnd(input);
    isStartingSpeechRecognition = true;
    updateSpeechButton();
    setSpeechStatus('Starting voice input...');

    try {
        speechRecognition.start();
    } catch (error) {
        isStartingSpeechRecognition = false;
        isListening = false;
        updateSpeechButton();
        setSpeechStatus(getSpeechStartErrorMessage(error), true);
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
    setHeaderMenuOpen(false);
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
    } else if (modalId === 'deleteConversationModal') {
        closeDeleteConversationModal();
    } else if (modalId === 'renameConversationModal') {
        closeRenameConversationModal();
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
    setHeaderMenuOpen(false);
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
    conversationHistoryCache.clear();
    isCreatingConversation = false;
    isLoadingConversations = false;
    conversationPendingDeletionId = null;
    isDeletingConversation = false;
    conversationPendingRenameId = null;
    isRenamingConversation = false;
    isSendingMessage = false;
    isTemporaryChat = false;
    lastSavedConversationId = null;
    closeConversationContextMenu();
    document.getElementById('renameConversationModal').style.display = 'none';
    updateTemporaryChatToggle();
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

async function loadUserHistory(conversationId = activeConversationId, forceRefresh = false) {
    if (!activeUserId || !conversationId) return;

    if (conversationId === TEMPORARY_CONVERSATION_ID) {
        const history = conversationHistoryCache.get(TEMPORARY_CONVERSATION_ID) || [];
        if (activeConversationId === TEMPORARY_CONVERSATION_ID) {
            renderConversationHistory(history);
        }
        return history;
    }

    const requestedUserId = activeUserId;
    const cachedHistory = conversationHistoryCache.get(conversationId);
    if (!forceRefresh && cachedHistory) {
        if (activeUserId === requestedUserId && activeConversationId === conversationId) {
            renderConversationHistory(cachedHistory);
        }
        return cachedHistory;
    }

    const chatBox = document.getElementById('chatBox');
    if (activeConversationId === conversationId) {
        chatBox.replaceChildren();
    }

    try {
        const response = await fetch(`/api/history?user_id=${encodeURIComponent(requestedUserId)}&conversation_id=${encodeURIComponent(conversationId)}`);
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to load this conversation.');
        }
        const history = cacheConversationHistory(conversationId, data.history);
        if (activeUserId === requestedUserId && activeConversationId === conversationId) {
            renderConversationHistory(history);
        }
        return history;
    }
    catch (error) {
        console.error('Failed to load history', error);
        if (activeUserId === requestedUserId && activeConversationId === conversationId) {
            setConversationStatus('Unable to load this conversation. Please try again.');
        }
    }
}

function showDeleteConversationError(message = '') {
    const errorMessage = document.getElementById('deleteConversationError');
    if (errorMessage) errorMessage.textContent = message;
}

function getDeleteConversationTitle(title) {
    const normalizedTitle = String(title || 'New chat').replace(/\s+/g, ' ').trim();
    if (normalizedTitle.length <= DELETE_CONVERSATION_TITLE_LIMIT) {
        return normalizedTitle;
    }

    return `${normalizedTitle.slice(0, DELETE_CONVERSATION_TITLE_LIMIT - 3).trimEnd()}...`;
}

function openDeleteConversationModal(conversationId) {
    if (!conversationId || isDeletingConversation) return;

    if (conversationId === activeConversationId && isSendingMessage) {
        setConversationStatus('Wait for the current reply before deleting this conversation.');
        return;
    }

    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;

    conversationPendingDeletionId = conversationId;
    showDeleteConversationError();
    document.getElementById('deleteConversationDescription').textContent =
        `Delete "${getDeleteConversationTitle(conversation.title)}" and all of its messages?`;
    document.getElementById('deleteConversationModal').style.display = 'flex';
    document.getElementById('deleteConversationCancelBtn').focus();
}

function closeDeleteConversationModal() {
    if (isDeletingConversation) return;

    conversationPendingDeletionId = null;
    showDeleteConversationError();
    document.getElementById('deleteConversationModal').style.display = 'none';
}

async function confirmDeleteConversation() {
    const conversationId = conversationPendingDeletionId;
    const requestedUserId = activeUserId;
    if (!conversationId || !requestedUserId || isDeletingConversation) return;

    const confirmButton = document.getElementById('deleteConversationConfirmBtn');
    const confirmButtonLabel = confirmButton?.textContent;
    isDeletingConversation = true;
    if (confirmButton) {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Deleting...';
    }
    showDeleteConversationError();

    try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: requestedUserId })
        });
        const data = await response.json();
        if (!response.ok || data.error || data.status !== 'deleted') {
            throw new Error(data.error || 'Failed to delete this conversation.');
        }
        if (activeUserId !== requestedUserId) return;

        const wasActiveConversation = activeConversationId === conversationId;
        conversations = conversations.filter((conversation) => conversation.id !== conversationId);
        conversationHistoryCache.delete(conversationId);
        if (lastSavedConversationId === conversationId) {
            lastSavedConversationId = null;
        }
        conversationPendingDeletionId = null;
        document.getElementById('deleteConversationModal').style.display = 'none';

        if (!wasActiveConversation) {
            renderConversationList();
            return;
        }

        stopSpeechRecognition(true);
        activeConversationId = null;
        document.getElementById('chatBox').replaceChildren();

        const nextConversation = conversations[0];
        if (nextConversation) {
            activeConversationId = nextConversation.id;
            lastSavedConversationId = nextConversation.id;
            renderConversationList();
            await loadUserHistory(nextConversation.id);
        } else {
            renderConversationList();
            await createNewChat();
        }
    } catch (error) {
        console.error('Failed to delete conversation', error);
        showDeleteConversationError(error.message || 'Unable to delete this conversation. Please try again.');
    } finally {
        isDeletingConversation = false;
        if (confirmButton) {
            confirmButton.disabled = false;
            confirmButton.textContent = confirmButtonLabel;
        }
    }
}

function clearChat() {
    setHeaderMenuOpen(false);
    if (!activeConversationId) return;
    if (isSendingMessage) {
        setConversationStatus('Wait for the current reply before clearing this chat.');
        return;
    }
    document.getElementById('clearChatModal').style.display = 'flex';
}

function closeClearChatModal() {
    document.getElementById('clearChatModal').style.display = 'none';
}

async function confirmClearChat() {
    closeClearChatModal();
    if (!activeConversationId) return;

    if (isTemporaryChat) {
        startTemporaryChat();
        return;
    }

    const conversationId = activeConversationId;
    const requestedUserId = activeUserId;

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
        if (activeUserId !== requestedUserId) return;

        upsertConversation(data.conversation);
        if (Array.isArray(data.history)) {
            const history = cacheConversationHistory(conversationId, data.history);
            if (activeConversationId === conversationId) {
                renderConversationHistory(history);
            }
        } else {
            conversationHistoryCache.delete(conversationId);
            if (activeConversationId === conversationId) {
                await loadUserHistory(conversationId, true);
            }
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
    const isTemporaryRequest = isTemporaryChat && conversationId === TEMPORARY_CONVERSATION_ID;
    const temporaryHistory = isTemporaryRequest ? getTemporaryHistoryForRequest() : null;
    const requestedUserId = activeUserId;
    const chatBox = document.getElementById('chatBox');
    isSendingMessage = true;
    updateTemporaryChatToggle();

    appendMessage(messageText, 'user');
    appendCachedMessage(conversationId, messageText, 'user');
    inputElement.value = '';
    const loadingDiv = appendMessage('Thinking...', 'assistant');

    try {
        const requestBody = {
            message: messageText,
            user_id: requestedUserId
        };
        if (isTemporaryRequest) {
            requestBody.temporary = true;
            requestBody.history = temporaryHistory;
        } else {
            requestBody.conversation_id = conversationId;
        }

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        const data = await response.json();
        if (!response.ok || data.error || !data.reply) {
            throw new Error(data.error || 'Failed to get response.');
        }
        if (activeUserId !== requestedUserId) return;
        if (!isTemporaryRequest && data.conversation) {
            upsertConversation(data.conversation);
        }

        const history = appendCachedMessage(conversationId, data.reply, 'assistant');
        if (activeConversationId !== conversationId) return;

        if (loadingDiv.isConnected) {
            loadingDiv.innerText = data.reply;
        } else {
            renderConversationHistory(history);
        }
    }
    catch (error) {
        if (!isTemporaryRequest) {
            conversationHistoryCache.delete(conversationId);
        }
        if (activeConversationId === conversationId) {
            loadingDiv.innerText = error.message === 'Failed to get response.'
                ? 'Error connecting to server.'
                : `Error: ${error.message}`;
        }
    } finally {
        isSendingMessage = false;
        updateTemporaryChatToggle();
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
        if (event.key === 'Escape' && conversationContextMenuId) {
            closeConversationContextMenu();
        }
        if (event.key === 'Escape' && headerMenuOpen) {
            setHeaderMenuOpen(false);
        }
        if (event.key === 'Escape' && conversationSidebarOpen) {
            setConversationSidebarOpen(false);
        }
    });

    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (headerMenuOpen && !target?.closest('#headerMenu')) {
            setHeaderMenuOpen(false);
        }
        if (conversationContextMenuId && !target?.closest('#conversationContextMenu')) {
            closeConversationContextMenu();
        }
    });

    window.addEventListener('resize', closeConversationContextMenu);
    document.addEventListener('scroll', closeConversationContextMenu, true);
});
initializeSpeechRecognition();
