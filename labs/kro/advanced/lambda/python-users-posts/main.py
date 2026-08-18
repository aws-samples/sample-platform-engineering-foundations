import json
import base64

# Import database operations
from db import (
    get_users, get_user, create_user, update_user, delete_user,
    get_posts, get_post, create_post, update_post, delete_post
)

def lambda_handler(event, context):
    """Main Lambda handler for routing API requests"""
    print(f"Request: {event['httpMethod']} {event['path']}")
    
    http_method = event['httpMethod']
    path = event['path']

    # Set CORS headers for all responses
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Amz-Date, X-Requested-With'
    }
    
    # Handle preflight OPTIONS request
    if event['httpMethod'] == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': '{}'
        }
        
    
    if event.get('body', None) and event.get('isBase64Encoded', False):
        event['body'] = base64.b64decode(event['body']).decode('utf-8')
    
    # Route request to appropriate handler
    if path == '/health' and http_method == 'GET':
        return handle_health()
    
    
    # User endpoints
    elif path == '/api/v1/users' and http_method == 'GET':
        return handle_get_users(event)
    elif path == '/api/v1/users' and http_method == 'POST':
        return handle_create_user(event)
    elif path.startswith('/api/v1/users/') and http_method == 'GET':
        return handle_get_user(event)
    elif path.startswith('/api/v1/users/') and http_method == 'PUT':
        return handle_update_user(event)
    elif path.startswith('/api/v1/users/') and http_method == 'DELETE':
        return handle_delete_user(event)
    
    # Post endpoints
    elif path == '/api/v1/posts' and http_method == 'GET':
        return handle_get_posts(event)
    elif path == '/api/v1/posts' and http_method == 'POST':
        return handle_create_post(event)
    elif path.startswith('/api/v1/posts/') and http_method == 'GET':
        return handle_get_post(event)
    elif path.startswith('/api/v1/posts/') and http_method == 'PUT':
        return handle_update_post(event)
    elif path.startswith('/api/v1/posts/') and http_method == 'DELETE':
        return handle_delete_post(event)
    
    else:
        return {
            'statusCode': 404,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Endpoint not found'})
        }

# Health check handler
def handle_health():
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({'status': 'UP'})
    }

# User handlers
def handle_get_users(event):
    try:
        query_params = event.get('queryStringParameters', {}) or {}
        page = int(query_params.get('page', '1'))
        limit = min(int(query_params.get('limit', '10')), 100)
        
        users = get_users(page, limit)
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(users, default=str)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_create_user(event):
    try:
        body = json.loads(event['body'])
        
        # Validate required fields
        if 'name' not in body:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Name is required'})
            }
        
        if 'email' not in body:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Email is required'})
            }
            
        user = create_user(body)
        
        return {
            'statusCode': 201,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(user, default=str)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_get_user(event):
    try:
        user_id = int(event['pathParameters']['id'])
        user = get_user(user_id)
        
        if user:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(user, default=str)
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'User with ID {user_id} not found'})
            }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_update_user(event):
    try:
        user_id = int(event['pathParameters']['id'])
        body = json.loads(event['body'])
        
        updated_user = update_user(user_id, body)
        
        if updated_user:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(updated_user, default=str)
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'User with ID {user_id} not found'})
            }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_delete_user(event):
    try:
        user_id = int(event['pathParameters']['id'])
        success = delete_user(user_id)
        
        if success:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'message': 'user deleted successfully'})
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'User with ID {user_id} not found'})
            }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
# Post handlers
def handle_get_posts(event):
    try:
        # Parse query parameters
        query_params = event.get('queryStringParameters', {}) or {}
        page = int(query_params.get('page', '1'))
        limit = min(int(query_params.get('limit', '10')), 100)
        
        posts = get_posts(page, limit)
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(posts, default=str)
        }
    except Exception as e:
        print(f"Error in handle_get_posts: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_create_post(event):
    try:
        body = json.loads(event['body'])
        
        # Validate required fields
        if 'title' not in body:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Title is required'})
            }
        
        if 'content' not in body:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Content is required'})
            }
            
        if 'user_id' not in body:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'User ID is required'})
            }
        
        # Ensure user_id is an integer
        try:
            body['user_id'] = int(body['user_id'])
        except ValueError:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'User ID must be an integer'})
            }
            
        # Create the post
        try:
            post = create_post(body)
            
            return {
                'statusCode': 201,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(post, default=str)
            }
        except ValueError as ve:
            # This specifically handles the case when the user doesn't exist
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': str(ve)})
            }
            
    except Exception as e:
        print(f"Error in handle_create_post: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_get_post(event):
    try:
        # Get post ID from path
        post_id = int(event['pathParameters']['id'])
        
        # Get post from DB
        post = get_post(post_id)
        
        if post:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(post, default=str)
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'Post with ID {post_id} not found'})
            }
    except Exception as e:
        print(f"Error in handle_get_post: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_update_post(event):
    try:
        # Get post ID from path
        post_id = int(event['pathParameters']['id'])
        
        # Parse request body
        body = json.loads(event['body'])
        
        # Update post in DB
        updated_post = update_post(post_id, body)
        
        if updated_post:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(updated_post, default=str)
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'Post with ID {post_id} not found'})
            }
    except Exception as e:
        print(f"Error in handle_update_post: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }

def handle_delete_post(event):
    try:
        # Get post ID from path
        post_id = int(event['pathParameters']['id'])
        
        # Delete post from DB
        success = delete_post(post_id)
        
        if success:
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'message': 'post deleted successfully'})
            }
        else:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': f'Post with ID {post_id} not found'})
            }
    except Exception as e:
        print(f"Error in handle_delete_post: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }