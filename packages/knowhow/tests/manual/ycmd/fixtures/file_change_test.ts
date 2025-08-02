interface User {
    name: string;
    age: number;
}

function createUser(name: string, age: number): User {
    // ERROR: Missing 'age' property - should cause TypeScript error
    return { name };
}

// ERROR: Using undefined variable - should cause TypeScript error
console.log(undefinedVariable);

// ERROR: Type mismatch - missing required property - should cause TypeScript error
const user: User = { name: 'Alice' };

export { createUser };