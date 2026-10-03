# @tyvm/knowhow-module-video-downloader

Adds video URL downloading to Knowhow plugins and to the conversion pipeline.

When this module is present in `modules`, it registers the `video-url` input resolver. This allows a video URL to flow through the existing local video-to-text converter:

```bash
knowhow convert \
  --input 'https://www.youtube.com/watch?v=…' \
  --to text
```

Resolver selection is automatic. It can also be forced explicitly:

```bash
knowhow convert \
  --input 'https://www.youtube.com/watch?v=…' \
  --input-resolver video-url \
  --to text
```

Downloads are reused from `.knowhow/downloads` when already present.

## Custom input resolvers

Modules receive the shared `ConversionService` during initialization and can register their own source resolver:

```ts
async init({ context }) {
  context?.Conversion?.registerResolver({
    name: "my-resolver",
    canHandle: (input) => input.startsWith("my-source://"),
    resolvePath: async (input) => {
      // Fetch or generate the source and return a local file path.
      return "/tmp/source.mp4";
    },
  });
}
```

`resolvePath` must return an existing local file. The file extension is used to select the converter chain.
