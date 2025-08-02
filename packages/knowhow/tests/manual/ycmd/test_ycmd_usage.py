class ExampleClass:
    """A sample class for testing ycmd functionality."""
    
    def __init__(self, name: str, value: int):
        self.name = name
        self.value = value
        self.computed_property = value * 2
    
    def get_info(self) -> str:
        """Return information about this instance."""
        return f"Name: {self.name}, Value: {self.value}"
    
    def calculate(self, multiplier: float) -> float:
        """Calculate a value based on the multiplier."""
        return self.value * multiplier

def create_example() -> ExampleClass:
    """Factory function to create an example instance."""
    return ExampleClass("test", 42)

# Test usage
if __name__ == "__main__":
    example = create_example()
    info = example.get_info()
    result = example.calculate(2.5)
    print(f"Info: {info}")
    print(f"Result: {result}")