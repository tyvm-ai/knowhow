export class Calculator {
  private history: number[] = [];
  private operationCount: number = 0;

  constructor(private precision: number = 2) {}

  add(a: number, b: number): number {
    // Enhanced add method with validation and logging
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Both arguments must be numbers');
    }
    
    const result = a + b;
    this.history.push(result);
    this.operationCount++;
    
    console.log(`Addition performed: ${a} + ${b} = ${result}`);
    return Math.round(result * Math.pow(10, this.precision)) / Math.pow(10, this.precision);
  }

  multiply(a: number, b: number): number {
    // Enhanced multiply method with validation
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Both arguments must be numbers');
    }
    
    const result = a * b;
    this.history.push(result);
    this.operationCount++;
    
    console.log(`Multiplication performed: ${a} * ${b} = ${result}`);
    return Math.round(result * Math.pow(10, this.precision)) / Math.pow(10, this.precision);
  }

  getHistory(): number[] {
    return [...this.history];
  }

  getOperationCount(): number {
    return this.operationCount;
  }

  clear(): void {
    this.history = [];
    this.operationCount = 0;
    console.log('Calculator cleared');
  }
}