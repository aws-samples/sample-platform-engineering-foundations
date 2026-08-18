import os
import boto3
from datetime import datetime
from botocore.exceptions import ClientError

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')
users_table = dynamodb.Table(os.environ.get('DYNAMO_DB_USERS_TABLE_NAME', 'Users'))
posts_table = dynamodb.Table(os.environ.get('DYNAMO_DB_POSTS_TABLE_NAME', 'Posts'))

# User operations
def get_users(page: int = 1, limit: int = 10):
    """Get paginated list of users"""
    try:
        response = users_table.scan(
            Limit=limit
        )
        return response.get('Items', [])
    except ClientError as e:
        print(f"Error scanning users table: {e}")
        raise

def get_user(user_id: int):
    """Get a single user by ID"""
    try:
        response = users_table.get_item(
            Key={
                'id': user_id
            }
        )
        return response.get('Item')
    except ClientError as e:
        print(f"Error getting user: {e}")
        raise

def create_user(user_data):
    """Create a new user"""
    try:
        # Add timestamps
        current_time = datetime.utcnow().isoformat()
        user_data['created_at'] = current_time
        user_data['updated_at'] = current_time
        
        # Generate ID (in production, use a better ID generation strategy)
        response = users_table.scan(
            ProjectionExpression="id",
            Select="SPECIFIC_ATTRIBUTES"
        )
        ids = [item['id'] for item in response.get('Items', [])]
        user_data['id'] = max(ids or [0]) + 1
        
        users_table.put_item(Item=user_data)
        return user_data
    except ClientError as e:
        print(f"Error creating user: {e}")
        raise

def update_user(user_id: int, update_data):
    """Update an existing user"""
    try:
        # Check if user exists
        user = get_user(user_id)
        if not user:
            return None
            
        # Update timestamps
        update_data['updated_at'] = datetime.utcnow().isoformat()
        update_data['id'] = user_id  # Ensure ID doesn't change
        
        # Merge with existing data
        updated_user = {**user, **update_data}
        
        users_table.put_item(Item=updated_user)
        return updated_user
    except ClientError as e:
        print(f"Error updating user: {e}")
        raise

def delete_user(user_id: int):
    """Delete a user"""
    try:
        # Check if user exists
        user = get_user(user_id)
        if not user:
            return False
            
        users_table.delete_item(
            Key={
                'id': user_id
            }
        )
        return True
    except ClientError as e:
        print(f"Error deleting user: {e}")
        raise

# Post operations
def get_posts(page: int = 1, limit: int = 10):
    """Get paginated list of posts"""
    try:
        response = posts_table.scan(
            Limit=limit
        )
        posts = response.get('Items', [])
        
        # Include user info
        for post in posts:
            if 'user_id' in post:
                user = get_user(post['user_id'])
                if user:
                    post['user'] = user
                    
        return posts
    except ClientError as e:
        print(f"Error scanning posts table: {e}")
        raise

def get_post(post_id: int):
    """Get a single post by ID"""
    try:
        response = posts_table.get_item(
            Key={
                'id': post_id
            }
        )
        post = response.get('Item')
        
        # Include user info if post exists
        if post and 'user_id' in post:
            user = get_user(post['user_id'])
            if user:
                post['user'] = user
                
        return post
    except ClientError as e:
        print(f"Error getting post: {e}")
        raise

def create_post(post_data):
    """Create a new post"""
    try:
        # Check if user exists
        user = get_user(post_data['user_id'])
        if not user:
            raise ValueError(f"User with ID {post_data['user_id']} not found")
            
        # Add timestamps
        current_time = datetime.utcnow().isoformat()
        post_data['created_at'] = current_time
        post_data['updated_at'] = current_time
        
        # Generate ID
        response = posts_table.scan(
            ProjectionExpression="id",
            Select="SPECIFIC_ATTRIBUTES"
        )
        ids = [item['id'] for item in response.get('Items', [])]
        post_data['id'] = max(ids or [0]) + 1
        
        posts_table.put_item(Item=post_data)
        
        # Include user in response but not in DB
        post_data['user'] = user
        return post_data
    except ClientError as e:
        print(f"Error creating post: {e}")
        raise

def update_post(post_id: int, update_data):
    """Update an existing post"""
    try:
        # Check if post exists
        post = get_post(post_id)
        if not post:
            return None
            
        # Update timestamp
        update_data['updated_at'] = datetime.utcnow().isoformat()
        
        # Don't change ID or user_id
        update_data['id'] = post_id
        update_data['user_id'] = post['user_id']
        
        # Merge with existing data
        if 'user' in post:
            del post['user']  # Remove user object before merging
        updated_post = {**post, **update_data}
        
        posts_table.put_item(Item=updated_post)
        
        # Return post with user info
        user = get_user(updated_post['user_id'])
        if user:
            updated_post['user'] = user
            
        return updated_post
    except ClientError as e:
        print(f"Error updating post: {e}")
        raise

def delete_post(post_id: int):
    """Delete a post"""
    try:
        # Check if post exists
        post = get_post(post_id)
        if not post:
            return False
            
        posts_table.delete_item(
            Key={
                'id': post_id
            }
        )
        return True
    except ClientError as e:
        print(f"Error deleting post: {e}")
        raise