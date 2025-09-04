
export class TestClass {
  method1() {
    return "valid";
  }
  
  method2( {  // Missing parameter, extra opening brace
    return "broken";
  }
  
  method3() {
    return "valid again";
  }
}
