#!/usr/bin/env python3

def hello_world():
    print("Hello, world!")
    # This should generate a warning about unused variable
    unused_var = "this is unused"
    return

if __name__ == "__main__":
    hello_world()