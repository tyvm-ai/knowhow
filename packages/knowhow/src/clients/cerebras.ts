import { HttpClient } from "./http";
import { CerebrasTextPricing } from "./pricing/cerebras";

export class GenericCerebrasClient extends HttpClient {
  constructor(apiKey: string) {
    super("https://api.cerebras.ai");
    this.setJwt(apiKey);
    this.setPrices(CerebrasTextPricing);
  }
}
