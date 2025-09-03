export class Calculator {
  private history: number[] = [];

  constructor(private precision: number = 2) {}

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push(result);
    return Math.round(result * Math.pow(10, this.precision)) / Math.pow(10, this.precision);
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push(result);
    return result;
  }

  getHistory(): number[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}