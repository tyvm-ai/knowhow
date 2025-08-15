import { HarmonyToolProcessor } from '../../src/processors/HarmonyToolProcessor';
import { Message } from '../../src/clients/types';

describe('HarmonyToolProcessor', () => {
  let processor: HarmonyToolProcessor;

  beforeEach(() => {
    // Reset singleton instance before each test
    (HarmonyToolProcessor as any).instance = null;
    processor = HarmonyToolProcessor.getInstance();
  });

  afterEach(() => {
    // Clean up singleton instance after each test
    (HarmonyToolProcessor as any).instance = null;
  });

  describe('singleton pattern', () => {
    it('should return the same instance when getInstance is called multiple times', () => {
      const instance1 = HarmonyToolProcessor.getInstance();
      const instance2 = HarmonyToolProcessor.getInstance();
      
      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(HarmonyToolProcessor);
    });

    it('should create new instance after reset', () => {
      const instance1 = HarmonyToolProcessor.getInstance();
      (HarmonyToolProcessor as any).instance = null;
      const instance2 = HarmonyToolProcessor.getInstance();
      
      expect(instance1).not.toBe(instance2);
      expect(instance2).toBeInstanceOf(HarmonyToolProcessor);
    });
  });

  describe('createProcessor', () => {
    it('should return a function', () => {
      const processorFunction = processor.createProcessor();
      expect(typeof processorFunction).toBe('function');
    });

    it('should not modify messages without Harmony patterns', () => {
      const message: Message = {
        role: 'assistant',
        content: 'This is a regular message without tool calls'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0]).toEqual(message);
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });
  });

  describe('Harmony pattern detection and conversion', () => {
    it('should detect and convert basic Harmony function call', () => {
      const message: Message = {
        role: 'assistant',
        content: 'I will help you. <|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1"}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('testTool');
      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe('{"param1":"value1"}');
      expect(modifiedMessages[0].tool_calls?.[0].type).toBe('function');
      expect(modifiedMessages[0].tool_calls?.[0].id).toMatch(/^harmony_call_/);
    });

    it('should detect and convert multiple Harmony function calls', () => {
      const message: Message = {
        role: 'assistant',
        content: `First tool: <|channel|>commentary to=functions.tool1 <|constrain|>json<|message|>{"param1": "value1"}
        Second tool: <|channel|>commentary to=functions.tool2 <|constrain|>json<|message|>{"param2": "value2"}`
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(2);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('tool1');
      expect(modifiedMessages[0].tool_calls?.[1].function.name).toBe('tool2');
    });

    it('should handle complex JSON arguments', () => {
      const message: Message = {
        role: 'assistant',
        content: `<|channel|>commentary to=functions.complexTool <|constrain|>json<|message|>{
          "param1": "value1",
          "param2": {
            "nested": "object",
            "array": [1, 2, 3]
          },
          "param3": true
        }`
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('complexTool');
      
      const args = JSON.parse(modifiedMessages[0].tool_calls?.[0].function.arguments || '{}');
      expect(args.param1).toBe('value1');
      expect(args.param2.nested).toBe('object');
      expect(args.param2.array).toEqual([1, 2, 3]);
      expect(args.param3).toBe(true);
    });

    it('should detect and convert Harmony final answer pattern', () => {
      const message: Message = {
        role: 'assistant',
        content: 'Here is my response: <|channel|>final<|message|>This is the final answer'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('finalAnswer');
      
      const args = JSON.parse(modifiedMessages[0].tool_calls?.[0].function.arguments || '{}');
      expect(args.answer).toBe('This is the final answer');
    });

    it('should detect and convert <|final|> pattern', () => {
      const message: Message = {
        role: 'assistant',
        content: 'Processing complete <|final|>Task completed successfully'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('finalAnswer');
      
      const args = JSON.parse(modifiedMessages[0].tool_calls?.[0].function.arguments || '{}');
      expect(args.answer).toBe('Task completed successfully');
    });
  });

  describe('message processing rules', () => {
    it('should only process assistant messages', () => {
      const userMessage: Message = {
        role: 'user',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1"}'
      };

      const systemMessage: Message = {
        role: 'system',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1"}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [userMessage, systemMessage];
      const modifiedMessages = [{ ...userMessage }, { ...systemMessage }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
      expect(modifiedMessages[1].tool_calls).toBeUndefined();
    });

    it('should only process string content', () => {
      const message: Message = {
        role: 'assistant',
        content: [
          { type: 'text', text: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1"}' }
        ]
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should skip messages that already have tool calls', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1"}',
        tool_calls: [{
          id: 'existing-call',
          type: 'function',
          function: {
            name: 'existingTool',
            arguments: '{"existing": "param"}'
          }
        }]
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('existingTool');
    });

    it('should skip messages without Harmony patterns', () => {
      const message: Message = {
        role: 'assistant',
        content: 'This is just a regular message with some <brackets> but no Harmony patterns'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });
  });

  describe('JSON validation and cleaning', () => {
    it('should handle valid JSON arguments', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{"param1": "value1", "param2": 42}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe('{"param1":"value1","param2":42}');
    });

    it('should handle malformed JSON by extracting what it can', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>some text {"param1": "value1"} more text'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe('{"param1":"value1"}');
    });

    it('should skip tool calls with invalid JSON that cannot be parsed', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>invalid json without braces'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should handle empty JSON object', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool <|constrain|>json<|message|>{}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe('{}');
    });
  });

  describe('tool call ID generation', () => {
    it('should generate unique IDs for each tool call', () => {
      const message: Message = {
        role: 'assistant',
        content: `<|channel|>commentary to=functions.tool1 <|constrain|>json<|message|>{"param1": "value1"}
        <|channel|>commentary to=functions.tool2 <|constrain|>json<|message|>{"param2": "value2"}`
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls?.length).toBe(2);
      const id1 = modifiedMessages[0].tool_calls?.[0].id;
      const id2 = modifiedMessages[0].tool_calls?.[1].id;
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^harmony_call_/);
      expect(id2).toMatch(/^harmony_call_/);
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle empty message content', () => {
      const message: Message = {
        role: 'assistant',
        content: ''
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0]).toEqual(message);
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should handle null content gracefully', () => {
      const message: Message = {
        role: 'assistant',
        content: null as any
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0]).toEqual(message);
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should handle undefined content gracefully', () => {
      const message: Message = {
        role: 'assistant',
        content: undefined as any
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0]).toEqual(message);
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should handle partial Harmony patterns', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.testTool but missing the rest'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should handle malformed tool names', () => {
      const message: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions. <|constrain|>json<|message|>{"param1": "value1"}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeUndefined();
    });

    it('should process multiple messages in array', () => {
      const message1: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.tool1 <|constrain|>json<|message|>{"param1": "value1"}'
      };

      const message2: Message = {
        role: 'assistant',
        content: 'Regular message without tools'
      };

      const message3: Message = {
        role: 'assistant',
        content: '<|channel|>commentary to=functions.tool2 <|constrain|>json<|message|>{"param2": "value2"}'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message1, message2, message3];
      const modifiedMessages = [{ ...message1 }, { ...message2 }, { ...message3 }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('tool1');
      expect(modifiedMessages[1].tool_calls).toBeUndefined();
      expect(modifiedMessages[2].tool_calls).toBeDefined();
      expect(modifiedMessages[2].tool_calls?.[0].function.name).toBe('tool2');
    });
  });

  describe('mixed pattern detection', () => {
    it('should detect both function calls and final answer patterns', () => {
      const message: Message = {
        role: 'assistant',
        content: `First I'll call a tool: <|channel|>commentary to=functions.searchTool <|constrain|>json<|message|>{"query": "test"}
        Then I'll provide the final answer: <|channel|>final<|message|>Here is the result`
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(2);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('searchTool');
      expect(modifiedMessages[0].tool_calls?.[1].function.name).toBe('finalAnswer');
    });

    it('should handle final pattern with empty content', () => {
      const message: Message = {
        role: 'assistant',
        content: 'Task completed <|final|>'
      };

      const processorFunction = processor.createProcessor();
      const originalMessages = [message];
      const modifiedMessages = [{ ...message }];
      
      processorFunction(originalMessages, modifiedMessages);
      
      expect(modifiedMessages[0].tool_calls).toBeDefined();
      expect(modifiedMessages[0].tool_calls?.length).toBe(1);
      expect(modifiedMessages[0].tool_calls?.[0].function.name).toBe('finalAnswer');
      
      const args = JSON.parse(modifiedMessages[0].tool_calls?.[0].function.arguments || '{}');
      expect(args.answer).toBe('Done');
    });
  });
});