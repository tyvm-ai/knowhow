/**
 * OpenAPI/Swagger schema resolution and type conversion utilities
 */

import { SwaggerSpec, ToolProp } from './types';

/**
 * Resolve a JSON schema $ref to its actual schema definition
 * Supports recursive refs and allOf merging
 */
export function resolveSchemaRef(ref: string, swaggerSpec: SwaggerSpec): any {
  if (!ref.startsWith('#/')) {
    return {};
  }

  const path = ref.substring(2).split('/');
  let current: any = swaggerSpec;

  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return {};
    }
    current = current[segment];
  }

  if (!current) {
    return {};
  }

  // Handle allOf composition
  if (current.allOf) {
    const merged: any = {
      type: 'object',
      properties: {},
      required: [],
    };

    for (const item of current.allOf) {
      let resolvedItem;
      if (item.$ref) {
        resolvedItem = resolveSchemaRef(item.$ref, swaggerSpec);
      } else {
        resolvedItem = item;
      }

      if (resolvedItem.properties) {
        Object.assign(merged.properties, resolvedItem.properties);
      }

      if (resolvedItem.required) {
        merged.required = [...merged.required, ...resolvedItem.required];
      }

      if (resolvedItem.type && resolvedItem.type !== 'object') {
        merged.type = resolvedItem.type;
      }
    }

    return merged;
  }

  // Handle nested $ref
  if (current.$ref) {
    return resolveSchemaRef(current.$ref, swaggerSpec);
  }

  return current;
}

/**
 * Convert an OpenAPI/Swagger schema to MCP tool property format
 * Handles refs, anyOf, oneOf, allOf, arrays, objects, and enums
 */
export function convertSwaggerTypeToToolProp(
  swaggerType: any,
  swaggerSpec: SwaggerSpec
): ToolProp {
  if (!swaggerType) {
    return { type: 'string' };
  }

  // Resolve $ref if present
  if (swaggerType.$ref) {
    const resolvedSchema = resolveSchemaRef(swaggerType.$ref, swaggerSpec);
    return convertSwaggerTypeToToolProp(resolvedSchema, swaggerSpec);
  }

  // Handle anyOf/oneOf/allOf by taking the first schema
  if (swaggerType.anyOf || swaggerType.oneOf || swaggerType.allOf) {
    const schemas = swaggerType.anyOf || swaggerType.oneOf || swaggerType.allOf;
    if (schemas.length > 0) {
      return convertSwaggerTypeToToolProp(schemas[0], swaggerSpec);
    }
  }

  const toolProp: ToolProp = {
    type: swaggerType.type || 'string',
    description: swaggerType.description,
  };

  // Handle enum values
  if (swaggerType.enum) {
    toolProp.enum = swaggerType.enum;
  }

  // Handle array types
  if (swaggerType.type === 'array' && swaggerType.items) {
    toolProp.items = {
      type: swaggerType.items.type || 'string',
    };

    if (swaggerType.items.properties) {
      toolProp.items.properties = {};
      for (const [key, value] of Object.entries(swaggerType.items.properties)) {
        toolProp.items.properties[key] = convertSwaggerTypeToToolProp(value, swaggerSpec);
      }
    } else if (swaggerType.items.$ref) {
      toolProp.items = convertSwaggerTypeToToolProp(swaggerType.items, swaggerSpec);
    }
  }

  // Handle object types with properties
  if (swaggerType.type === 'object' && swaggerType.properties) {
    toolProp.properties = {};
    for (const [key, value] of Object.entries(swaggerType.properties)) {
      toolProp.properties[key] = convertSwaggerTypeToToolProp(value, swaggerSpec);
    }
  }

  return toolProp;
}

/**
 * Validate that a baseUrl is safe and matches the swagger spec servers
 * Prevents SSRF attacks by ensuring the URL is in the spec and not a private IP
 */
export function validateBaseUrl(baseUrl: string, swaggerSpec: SwaggerSpec): string | null {
  try {
    const url = new URL(baseUrl);

    // Only allow https or http schemes
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return 'Invalid URL scheme: only http or https is allowed';
    }

    // Block localhost and private IP ranges
    const hostname = url.hostname;

    // Block localhost
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return 'Invalid URL: localhost and loopback addresses are not allowed';
    }

    // Block private IP ranges (RFC1918)
    const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Pattern);
    if (match) {
      const [, a, b, c, d] = match.map(Number);
      // 10.0.0.0/8
      if (a === 10) return 'Invalid URL: private IP range not allowed';
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return 'Invalid URL: private IP range not allowed';
      // 192.168.0.0/16
      if (a === 192 && b === 168) return 'Invalid URL: private IP range not allowed';
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return 'Invalid URL: private IP range not allowed';
    }

    // Check if baseUrl matches one of the servers in the swagger spec
    if (!swaggerSpec.servers || swaggerSpec.servers.length === 0) {
      return null; // No servers defined, allow any URL
    }

    const allowedUrls = swaggerSpec.servers
      .map((s) => {
        try {
          return new URL(s.url).origin;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!allowedUrls.includes(url.origin)) {
      return `Invalid baseUrl: must match one of the swagger spec servers: ${allowedUrls.join(', ')}`;
    }
    return null;
  } catch {
    return 'Invalid URL format';
  }
}
