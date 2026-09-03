from flask import Flask, request, jsonify
from flask_cors import CORS
import boto3
from boto3.dynamodb.conditions import Key
import json
import os
import hashlib
import re
import time
import uuid
from decimal import Decimal

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# --- CONFIGURATION ---
# When deployed on Render, boto3 will automatically read your AWS keys from environment variables.
REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
MODEL_ID = "us.amazon.nova-micro-v1:0"
USERS_TABLE = "NovaChatUsers"
LEGACY_MESSAGES_TABLE = "NovaChatMessages"
CONVERSATIONS_TABLE = "NovaChatConversations"
CONVERSATION_MESSAGES_TABLE = "NovaChatConversationMessages"
DEFAULT_CONVERSATION_TITLE = "New chat"
MODEL_CONTEXT_MESSAGE_LIMIT = 5

bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)
dynamodb_client = boto3.client("dynamodb", region_name=REGION)
dynamodb_resource = boto3.resource("dynamodb", region_name=REGION)

def get_dynamo_resource():
    # Reuse one SDK resource so DynamoDB connections can stay pooled between requests.
    return dynamodb_resource

# --- DATABASE FUNCTIONS ---

def create_table_if_needed(table_name, key_schema, attribute_definitions):
    try:
        dynamodb_client.create_table(
            TableName=table_name,
            KeySchema=key_schema,
            AttributeDefinitions=attribute_definitions,
            BillingMode="PAY_PER_REQUEST"
        )
        print(f"Creating {table_name} in AWS... (This takes a few seconds)")
        get_dynamo_resource().Table(table_name).wait_until_exists()
    except dynamodb_client.exceptions.ResourceInUseException:
        pass

def init_db():
    """Creates DynamoDB tables in AWS if they do not already exist."""
    create_table_if_needed(
        USERS_TABLE,
        [{"AttributeName": "email", "KeyType": "HASH"}],
        [{"AttributeName": "email", "AttributeType": "S"}]
    )
    create_table_if_needed(
        LEGACY_MESSAGES_TABLE,
        [
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "timestamp", "KeyType": "RANGE"}
        ],
        [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "N"}
        ]
    )
    create_table_if_needed(
        CONVERSATIONS_TABLE,
        [
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "conversation_id", "KeyType": "RANGE"}
        ],
        [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "conversation_id", "AttributeType": "S"}
        ]
    )
    create_table_if_needed(
        CONVERSATION_MESSAGES_TABLE,
        [
            {"AttributeName": "conversation_id", "KeyType": "HASH"},
            {"AttributeName": "timestamp", "KeyType": "RANGE"}
        ],
        [
            {"AttributeName": "conversation_id", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "N"}
        ]
    )

def current_timestamp():
    return Decimal(str(time.time()))

def get_all_query_items(table, key_condition, scan_index_forward=True):
    query_args = {
        "KeyConditionExpression": key_condition,
        "ScanIndexForward": scan_index_forward
    }
    response = table.query(**query_args)
    items = response.get("Items", [])

    while response.get("LastEvaluatedKey"):
        response = table.query(
            ExclusiveStartKey=response["LastEvaluatedKey"],
            **query_args
        )
        items.extend(response.get("Items", []))

    return items

def get_first_name(name):
    name_parts = str(name or "").split()
    return name_parts[0] if name_parts else "there"

def get_user_name(user_id):
    users_table = get_dynamo_resource().Table(USERS_TABLE)
    user_response = users_table.get_item(Key={"email": user_id})
    return get_first_name(user_response.get("Item", {}).get("name"))

def get_greeting(user_id):
    return f"Hello {get_user_name(user_id)}! How can I help you today?"

def make_conversation_title(text):
    title = " ".join(str(text or "").split())
    if not title:
        return DEFAULT_CONVERSATION_TITLE
    if len(title) <= 54:
        return title
    return f"{title[:51].rstrip()}..."

def get_conversation_title_from_messages(messages):
    for message in messages:
        if message.get("role") == "user":
            return make_conversation_title(message.get("text_content"))
    return DEFAULT_CONVERSATION_TITLE

def to_public_conversation(conversation):
    return {
        "id": conversation["conversation_id"],
        "title": conversation.get("title", DEFAULT_CONVERSATION_TITLE),
        "created_at": float(conversation.get("created_at", 0)),
        "updated_at": float(conversation.get("updated_at", 0))
    }

def to_history_message(message):
    return {
        "role": message["role"],
        "content": [{"text": message["text_content"]}]
    }

def to_history_messages(messages):
    return [to_history_message(message) for message in messages]

def make_conversation_message(user_id, conversation_id, role, text, timestamp=None):
    return {
        "conversation_id": conversation_id,
        "timestamp": timestamp or current_timestamp(),
        "user_id": user_id,
        "role": role,
        "text_content": text
    }

def get_conversation(user_id, conversation_id):
    table = get_dynamo_resource().Table(CONVERSATIONS_TABLE)
    return table.get_item(
        Key={"user_id": user_id, "conversation_id": conversation_id}
    ).get("Item")

def get_user_conversations(user_id):
    table = get_dynamo_resource().Table(CONVERSATIONS_TABLE)
    conversations = get_all_query_items(table, Key("user_id").eq(user_id))
    return sorted(
        conversations,
        key=lambda conversation: conversation.get("updated_at", Decimal("0")),
        reverse=True
    )

def get_conversation_messages(conversation_id):
    table = get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE)
    return get_all_query_items(table, Key("conversation_id").eq(conversation_id))

def get_recent_conversation_messages(conversation_id, limit):
    table = get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE)
    response = table.query(
        KeyConditionExpression=Key("conversation_id").eq(conversation_id),
        ScanIndexForward=False,
        Limit=limit
    )
    # DynamoDB returns newest first here; Nova needs chronological messages.
    return list(reversed(response.get("Items", [])))

def update_conversation_activity(user_id, conversation_id, updated_at, title=None):
    table = get_dynamo_resource().Table(CONVERSATIONS_TABLE)
    update_expression = "SET updated_at = :updated_at"
    expression_values = {":updated_at": updated_at}

    if title is not None:
        update_expression += ", title = :title"
        expression_values[":title"] = title

    table.update_item(
        Key={"user_id": user_id, "conversation_id": conversation_id},
        UpdateExpression=update_expression,
        ExpressionAttributeValues=expression_values
    )

def save_conversation_message(user_id, conversation, role, text):
    timestamp = current_timestamp()
    conversation_id = conversation["conversation_id"]
    message = make_conversation_message(
        user_id,
        conversation_id,
        role,
        text,
        timestamp
    )
    messages_table = get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE)
    messages_table.put_item(Item=message)

    title = None
    if role == "user" and conversation.get("title") == DEFAULT_CONVERSATION_TITLE:
        title = make_conversation_title(text)
    update_conversation_activity(user_id, conversation_id, timestamp, title)

    updated_conversation = {**conversation, "updated_at": timestamp}
    if title is not None:
        updated_conversation["title"] = title
    return updated_conversation, message

def create_conversation(user_id):
    conversation_id = uuid.uuid4().hex
    created_at = current_timestamp()
    conversation = {
        "user_id": user_id,
        "conversation_id": conversation_id,
        "title": DEFAULT_CONVERSATION_TITLE,
        "created_at": created_at,
        "updated_at": created_at
    }
    greeting = make_conversation_message(
        user_id,
        conversation_id,
        "assistant",
        get_greeting(user_id),
        created_at
    )

    get_dynamo_resource().Table(CONVERSATIONS_TABLE).put_item(Item=conversation)
    get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE).put_item(Item=greeting)
    return conversation, [to_history_message(greeting)]

def ensure_user_conversations(user_id):
    conversations = get_user_conversations(user_id)
    if conversations:
        return conversations

    # Copy pre-sidebar history once into an independent conversation without deleting it.
    legacy_table = get_dynamo_resource().Table(LEGACY_MESSAGES_TABLE)
    legacy_messages = get_all_query_items(legacy_table, Key("user_id").eq(user_id))
    if legacy_messages:
        conversation_id = f"legacy-{uuid.uuid5(uuid.NAMESPACE_URL, user_id).hex}"
        messages_table = get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE)
        with messages_table.batch_writer() as batch:
            for message in legacy_messages:
                batch.put_item(
                    Item={
                        "conversation_id": conversation_id,
                        "timestamp": message["timestamp"],
                        "user_id": user_id,
                        "role": message["role"],
                        "text_content": message["text_content"]
                    }
                )

        conversation = {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "title": get_conversation_title_from_messages(legacy_messages),
            "created_at": legacy_messages[0]["timestamp"],
            "updated_at": legacy_messages[-1]["timestamp"]
        }
        get_dynamo_resource().Table(CONVERSATIONS_TABLE).put_item(Item=conversation)
        return [conversation]

    conversation, _ = create_conversation(user_id)
    return [conversation]

def load_history(user_id, conversation):
    conversation_id = conversation["conversation_id"]
    items = get_conversation_messages(conversation_id)
    if not items:
        greeting = make_conversation_message(
            user_id,
            conversation_id,
            "assistant",
            get_greeting(user_id)
        )
        get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE).put_item(Item=greeting)
        update_conversation_activity(user_id, conversation_id, greeting["timestamp"])
        items = [greeting]

    return to_history_messages(items)

def delete_conversation_messages(conversation_id):
    table = get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE)
    messages = get_conversation_messages(conversation_id)
    with table.batch_writer() as batch:
        for message in messages:
            batch.delete_item(
                Key={
                    "conversation_id": conversation_id,
                    "timestamp": message["timestamp"]
                }
            )

def clear_conversation(user_id, conversation):
    conversation_id = conversation["conversation_id"]
    timestamp = current_timestamp()
    greeting = make_conversation_message(
        user_id,
        conversation_id,
        "assistant",
        get_greeting(user_id),
        timestamp
    )

    delete_conversation_messages(conversation_id)
    update_conversation_activity(
        user_id,
        conversation_id,
        timestamp,
        DEFAULT_CONVERSATION_TITLE
    )
    get_dynamo_resource().Table(CONVERSATION_MESSAGES_TABLE).put_item(Item=greeting)

    cleared_conversation = {
        **conversation,
        "title": DEFAULT_CONVERSATION_TITLE,
        "updated_at": timestamp
    }
    return cleared_conversation, [to_history_message(greeting)]

def delete_legacy_messages(user_id):
    table = get_dynamo_resource().Table(LEGACY_MESSAGES_TABLE)
    messages = get_all_query_items(table, Key("user_id").eq(user_id))
    with table.batch_writer() as batch:
        for message in messages:
            batch.delete_item(
                Key={"user_id": user_id, "timestamp": message["timestamp"]}
            )

def delete_conversation(user_id, conversation):
    conversation_id = conversation["conversation_id"]
    delete_conversation_messages(conversation_id)
    get_dynamo_resource().Table(CONVERSATIONS_TABLE).delete_item(
        Key={"user_id": user_id, "conversation_id": conversation_id}
    )

    # Prevent a deleted migrated legacy chat from being imported again on next sign-in.
    legacy_conversation_id = f"legacy-{uuid.uuid5(uuid.NAMESPACE_URL, user_id).hex}"
    if conversation_id == legacy_conversation_id:
        delete_legacy_messages(user_id)

def delete_user_conversations(user_id):
    conversations = get_user_conversations(user_id)
    conversations_table = get_dynamo_resource().Table(CONVERSATIONS_TABLE)

    for conversation in conversations:
        delete_conversation_messages(conversation["conversation_id"])

    with conversations_table.batch_writer() as batch:
        for conversation in conversations:
            batch.delete_item(
                Key={
                    "user_id": user_id,
                    "conversation_id": conversation["conversation_id"]
                }
            )

# --- VALIDATION HELPERS ---

def is_valid_email(email):
    return re.match(r"^[\w\.-]+@[\w\.-]+\.\w+$", email)

def is_valid_password(password):
    if len(password) < 8: return False
    if not re.search(r"[A-Z]", password): return False
    if not re.search(r"[a-z]", password): return False
    if not re.search(r"\d", password): return False
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", password): return False
    return True

# --- AUTHENTICATION ROUTES ---

@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.json
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "").strip()
    
    if not is_valid_email(email):
        return jsonify({"error": "Invalid email address format."}), 400
    if not is_valid_password(password):
        return jsonify({"error": "Password must be at least 8 characters long, include an uppercase letter, a lowercase letter, a number, and a special character."}), 400

    hashed_pw = hashlib.sha256(password.encode()).hexdigest()

    try:
        table = get_dynamo_resource().Table(USERS_TABLE)

        # Check if user exists
        response = table.get_item(Key={'email': email})
        if 'Item' in response:
            return jsonify({"error": "An account with this email already exists."}), 400

        table.put_item(
            Item={
                'name': name,
                'email': email,
                'password_hash': hashed_pw
            }
        )
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"DynamoDB Signup Error: {str(e)}")
        return jsonify({"error": f"Database Connection Error: {str(e)}"}), 500


@app.route("/api/signin", methods=["POST"])
def signin():
    data = request.json
    email = data.get("email", "").strip().lower()
    password = data.get("password", "").strip()
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()

    try:
        table = get_dynamo_resource().Table(USERS_TABLE)
        response = table.get_item(Key={'email': email})
        item = response.get('Item')
    
        if item and item.get('password_hash') == hashed_pw:
            user_name = item.get('name')
            return jsonify({"status": "success", "user_id": email, "name": user_name})
        else:
            return jsonify({"error": "Invalid email or password"}), 401

    except Exception as e:
        # This will catch AWS errors and send them to your browser console as JSON!
        print(f"DynamoDB Signin Error: {str(e)}")
        return jsonify({"error": f"Database Connection Error: {str(e)}"}), 500

@app.route("/api/delete_account", methods=["POST"])
def delete_account():
    data = request.json
    user_id = data.get("user_id")
    password = data.get("password")
    
    if not user_id or not password:
        return jsonify({"error": "Email and password are required"}), 400
        
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()
        
    try:
        # 1. Verify user credentials first.
        users_table = get_dynamo_resource().Table(USERS_TABLE)
        response = users_table.get_item(Key={'email': user_id})
        item = response.get('Item')
        
        if not item or item.get('password_hash') != hashed_pw:
            return jsonify({"error": "Incorrect password."}), 401
            
        # 2. Delete every conversation and the pre-sidebar message history.
        delete_user_conversations(user_id)
        delete_legacy_messages(user_id)

        # 3. Delete the user from the Users table.
        users_table.delete_item(
            Key={'email': user_id}
        )
        
        return jsonify({"status": "deleted"})
        
    except Exception as e:
        print(f"DynamoDB Delete Error: {str(e)}")
        return jsonify({"error": f"Database Connection Error: {str(e)}"}), 500

# --- CHAT ROUTES ---

@app.route("/")
def home():
    return app.send_static_file("index.html")

@app.route("/api/conversations", methods=["GET"])
def list_conversations():
    user_id = request.args.get("user_id")
    include_active_history = request.args.get("include_active_history") == "true"
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    try:
        conversations = ensure_user_conversations(user_id)
        response = {
            "conversations": [to_public_conversation(conversation) for conversation in conversations]
        }
        if include_active_history and conversations:
            active_conversation = conversations[0]
            response["active_conversation"] = to_public_conversation(active_conversation)
            response["history"] = load_history(user_id, active_conversation)
        return jsonify(response)
    except Exception as error:
        print(f"DynamoDB conversation list error: {error}")
        return jsonify({"error": "Failed to load conversations!"}), 500

@app.route("/api/conversations", methods=["POST"])
def create_new_conversation():
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    try:
        # The sign-in list request already handles a legacy-history migration.
        conversation, history = create_conversation(user_id)
        return jsonify({
            "conversation": to_public_conversation(conversation),
            "history": history
        }), 201
    except Exception as error:
        print(f"DynamoDB new conversation error: {error}")
        return jsonify({"error": "Failed to create a new chat!"}), 500

@app.route("/api/conversations/<conversation_id>", methods=["DELETE"])
def delete_saved_conversation(conversation_id):
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    try:
        conversation = get_conversation(user_id, conversation_id)
        if not conversation:
            return jsonify({"error": "Conversation not found!"}), 404
        delete_conversation(user_id, conversation)
        return jsonify({"status": "deleted", "conversation_id": conversation_id})
    except Exception as error:
        print(f"DynamoDB delete conversation error: {error}")
        return jsonify({"error": "Failed to delete this conversation!"}), 500

@app.route("/api/history", methods=["GET"])
def get_history():
    user_id = request.args.get("user_id")
    conversation_id = request.args.get("conversation_id")
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    if not conversation_id:
        return jsonify({"error": "A conversation is required"}), 400

    try:
        conversation = get_conversation(user_id, conversation_id)
        if not conversation:
            return jsonify({"error": "Conversation not found!"}), 404
        return jsonify({"history": load_history(user_id, conversation)})
    except Exception as error:
        print(f"DynamoDB history error: {error}")
        return jsonify({"error": "Failed to load this conversation!"}), 500

@app.route("/api/clear", methods=["POST"])
def clear_history():
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    conversation_id = data.get("conversation_id")
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    if not conversation_id:
        return jsonify({"error": "A conversation is required"}), 400

    try:
        conversation = get_conversation(user_id, conversation_id)
        if not conversation:
            return jsonify({"error": "Conversation not found!"}), 404
        cleared_conversation, history = clear_conversation(user_id, conversation)
        return jsonify({
            "status": "cleared",
            "conversation": to_public_conversation(cleared_conversation),
            "history": history
        })
    except Exception as error:
        print(f"DynamoDB clear conversation error: {error}")
        return jsonify({"error": "Failed to clear this conversation!"}), 500

@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    new_message_text = data.get("message", "").strip()
    user_id = data.get("user_id")
    conversation_id = data.get("conversation_id")

    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    if not conversation_id:
        return jsonify({"error": "A conversation is required"}), 400
    if not new_message_text:
        return jsonify({"error": "No message provided"}), 400

    conversation = get_conversation(user_id, conversation_id)
    if not conversation:
        return jsonify({"error": "Conversation not found!"}), 404

    conversation, _ = save_conversation_message(
        user_id,
        conversation,
        "user",
        new_message_text
    )
    recent_messages = get_recent_conversation_messages(
        conversation_id,
        MODEL_CONTEXT_MESSAGE_LIMIT
    )
    api_messages = to_history_messages(recent_messages)
    if api_messages and api_messages[0]["role"] == "assistant":
        api_messages.pop(0)

    payload = {
        "messages": api_messages,
        "inferenceConfig": {"maxTokens": 1024, "temperature": 0.7}
    }

    try:
        response = bedrock_client.invoke_model(
            modelId=MODEL_ID, contentType="application/json", accept="application/json", body=json.dumps(payload)
        )
        response_body = json.loads(response['body'].read())
        assistant_reply = response_body['output']['message']['content'][0]['text']
        conversation, _ = save_conversation_message(
            user_id,
            conversation,
            "assistant",
            assistant_reply
        )
        return jsonify({
            "reply": assistant_reply,
            "conversation": to_public_conversation(conversation)
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

try:
    init_db()
except Exception as e:
    print("Database init skipped/failed:", e)

if __name__ == "__main__":
    print("Server starting on http://127.0.0.1:3008")
    app.run(host="0.0.0.0", port=3008, debug=True)
