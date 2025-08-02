// Sample TypeScript file to test ycmd completion
interface User {
  id: number;
  name: string;
  email: string;
}

class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findUserById(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }

  getAllUsers(): User[] {
    return this.users;
  }
}

const service = new UserService();
service.addUser({ id: 1, name: "John", email: "john@example.com" });

// Test completion at this point - should show User properties
const user = service.findUserById(1);
if (user) {
  console.log(user.name); // <- cursor here for completion test
}

// Test go-to-definition on UserService
const anotherService = new UserService(); // <- should jump to class definition