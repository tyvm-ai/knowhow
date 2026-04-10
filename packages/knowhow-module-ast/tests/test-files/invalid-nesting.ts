export class Calculator {
  private result: number = 0;

  add(value: number): Calculator {
    this.result += value;
    return this;
  }

  subtract(value: number): Calculator {
    this.result -= value;
    return this;
  }

  multiply(value: number): Calculator {
    this.result *= value;
    return this;
  }

  getResult(): number {
    return this.result;
  }
}

export function createCalculator(): Calculator {
  return new Calculator();
}

describe("Calculator Tests", (() => {
  it("should perform basic arithmetic", () => {
    const calc = createCalculator();
    const result = calc.add(5).multiply(2).subtract(3).getResult();
    expect(result).toBe(7);
  });

  it("should chain operations correctly", () => {
    const calc = new Calculator();
    expect(calc.add(10).add(5).getResult()).toBe(15);
  });
});
