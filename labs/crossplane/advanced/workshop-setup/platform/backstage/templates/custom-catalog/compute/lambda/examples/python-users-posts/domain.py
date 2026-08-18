import datetime
from typing import Optional, Any
from pydantic import BaseModel

class UserBase(BaseModel):
    name: str
    email: str

class UserCreate(UserBase):
    pass

class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None

class User(UserBase):
    id: int
    created_at: datetime.datetime
    updated_at: datetime.datetime
    
    def validate(self) -> Optional[str]:
        if not self.name:
            return "Name is required"
        if not self.email:
            return "Email is required"
        return None

class PostBase(BaseModel):
    title: str
    content: str

class PostCreate(PostBase):
    user_id: int

class PostUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None

class Post(PostBase):
    id: int
    user_id: int
    user: Optional[User] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    
    def validate(self) -> Optional[str]:
        if not self.title:
            return "Title is required"
        if not self.content:
            return "Content is required"
        if self.user_id == 0:
            return "User ID is required"
        return None

class ErrorResponse(BaseModel):
    error: str