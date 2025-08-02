// TypeScript file with clear errors to test diagnostics
interface User {
    name: string;
    age: number;
    email?: string;
}

function createUser(name: string, age: number): User {
    // This should trigger a type error - missing 'age' property
    return { name }; 
}

// This should trigger an error - React is not imported
const component = React.createElement('div');

// This should trigger an error - missing 'age' property  
const user: User = { name: 'Alice' };

// This should trigger an error - undefined variable
console.log(undefinedVariable);

// This should trigger an error - calling method on possibly undefined
const maybeString: string | undefined = undefined;
maybeString.toUpperCase();

export { createUser };