
export class Calculator {
  private result: number = 0;

  add(value: number): Calculator {
    this.result += value;
    return this;
  }

  // This method has broken syntax
  subtract(value number): Calculator {  // Missing colon
    this.result -= value;
    return this;
  }

  multiply(value: number): Calculator {
    this.result *= value;
    return this;
  }
}