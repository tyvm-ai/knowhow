#!/usr/bin/env python3
"""
Simple test file to verify ycmd tools work correctly
"""

def fibonacci(n):
    """Calculate fibonacci number"""
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

def main():
    print("Testing ycmd tools")
    result = fibonacci(10)
    print(f"Fibonacci of 10 is: {result}")

if __name__ == "__main__":
    main()