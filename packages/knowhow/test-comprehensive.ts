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

  findUser(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }
}

const service = new UserService();
service.addUser({
  id: 1,
  name: "John",
  email: "john@example.com"
});

// Test completion on service methods
const result = service.fi; // Should complete to findUser

// Test completion on User interface properties
const user: User = { id: 1, name: "Test", email: "test@test.com" };
console.log(user.na); // Should complete to name