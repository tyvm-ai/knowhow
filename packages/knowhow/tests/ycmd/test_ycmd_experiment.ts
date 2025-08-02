// Test file for experimenting with ycmd tools
import * as fs from 'fs';
import * as path from 'path';

interface User {
  id: number;
  name: string;
  email: string;
}

class UserManager {
  private users: User[] = [];

  constructor() {
    this.loadUsers();
  }

  addUser(user: User): void {
    this.users.push(user);
  }

  getUserById(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }

  private loadUsers(): void {
    // Intentional error: using non-existent method
    const data = fs.readFileSync('./users.json', 'utf8');
    this.users = JSON.parse(data);
  }

  updateUserEmail(userId: number, newEmail: string): boolean {
    const user = this.getUserById(userId);
    if (user) {
      user.email = newEmail;
      return true;
    }
    return false;
  }
}

// Test function with parameters
function calculateTotal(items: number[], taxRate: number = 0.1): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  return subtotal * (1 + taxRate);
}

export { UserManager, calculateTotal };