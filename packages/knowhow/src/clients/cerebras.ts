import { HttpClient } from "./http";

export class GenericCerebrasClient extends HttpClient {
  constructor(apiKey: string) {
    super("https://api.cerebras.ai");
    this.setJwt(apiKey);
  }
}
