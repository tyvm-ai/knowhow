# Media Processing with Knowhow

This guide covers how to process audio, video, and PDF files using Knowhow's configuration system. Knowhow automatically converts media files to text for AI processing, supports pipeline chaining where outputs become inputs, and allows assignment of processing tasks to specific agents.

---

## Supported File Types

Knowhow's `convertToText()` function automatically handles these file types:

**Audio Files:**
- `.mp3` - MP3 audio files
- `.wav` - WAV audio files  
- `.m4a` - M4A audio files
- `.mpga` - MPEG audio files

**Video Files:**
- `.mp4` - MP4 video files
- `.webm` - WebM video files
- `.mov` - QuickTime video files
- `.mpeg` - MPEG video files

**Document Files:**
- `.pdf` - PDF documents

All other file types are processed as plain text files.

---

## Audio Processing

### Basic Audio Transcription

```json
{
  "sources": [
    {
      "input": "./recordings/**/*.mp3",
      "output": "./transcripts/",
      "prompt": "BasicTranscript"
    }
  ]
}
```

Audio files are automatically:
1. Split into 30-second chunks by default (configurable via `chunkTime` parameter)
2. Transcribed using speech-to-text via `Downloader.transcribeChunks()`
3. Saved as `transcript.json` in a folder named after the audio file
4. Formatted with timestamps: `[0:30s] transcript text [30:60s] more text`

### Audio with Agent Assignment

```json
{
  "sources": [
    {
      "input": "./meetings/**/*.wav",
      "output": "./meeting-notes/",
      "prompt": "MeetingNotes",
      "agent": "patcher"
    }
  ]
}
```

### Meeting Recording Pipeline

```json
{
  "sources": [
    {
      "input": "./meetings/**/*.m4a",
      "output": "./meetings/transcripts/",
      "prompt": "MeetingTranscriber"
    },
    {
      "input": "./meetings/transcripts/**/*.mdx",
      "output": "./meetings/summaries/",
      "prompt": "MeetingSummarizer"
    },
    {
      "input": "./meetings/summaries/**/*.mdx", 
      "output": "./meetings/action-items.txt",
      "prompt": "ActionItemExtractor"
    }
  ]
}
```

This pipeline demonstrates chaining:
1. Audio files → transcripts (multi-output to directory)
2. Transcripts → summaries (multi-output to directory)  
3. Summaries → single action items file (single output)

---

## Video Processing

### Basic Video Processing

```json
{
  "sources": [
    {
      "input": "./videos/**/*.mp4",
      "output": "./video-analysis/",
      "prompt": "VideoAnalyzer"
    }
  ]
}
```

Video files are processed by:
1. Extracting and transcribing audio (same process as audio files)
2. Extracting keyframes at regular intervals using `Downloader.extractKeyframes()`
3. Analyzing visual content of each keyframe
4. Combining transcript and visual analysis with timestamps

The actual output format from `convertVideoToText()` includes:
```
Chunk: (1/10):
Start Timestamp: [0s]
Visual: description of keyframe
Audio: transcribed audio
End Timestamp: [30s]
```

### Video Content Organization

```json
{
  "sources": [
    {
      "input": "./raw-videos/**/*.webm",
      "output": "./organized-videos/",
      "prompt": "VideoOrganizer",
      "agent": "patcher"
    }
  ]
}
```

This example shows assigning video processing to the "patcher" agent.

---

## PDF Processing

### Document Analysis

```json
{
  "sources": [
    {
      "input": "./documents/**/*.pdf",
      "output": "./document-summaries/",
      "prompt": "DocumentSummarizer"
    }
  ]
}
```

PDF files are processed by:
1. Reading the file using `fs.readFileSync()`
2. Extracting text content using the `pdf-parse` library
3. Returning the extracted text via `data.text`
4. Applying the specified prompt for analysis

### Multi-Document Research Pipeline

```json
{
  "sources": [
    {
      "input": "./research-papers/**/*.pdf",
      "output": "./paper-summaries/",
      "prompt": "AcademicSummarizer"
    },
    {
      "input": "./paper-summaries/**/*.mdx",
      "output": "./research-synthesis.md",
      "prompt": "ResearchSynthesizer"
    }
  ]
}
```

---

## Agent Assignment

### Assigning Processing to Specific Agents

```json
{
  "sources": [
    {
      "input": "./meetings/**/*.mov",
      "output": "./meeting-notes/",
      "prompt": "MeetingNotes",
      "agent": "patcher"
    }
  ]
}
```

The `agent` parameter assigns processing to a specific agent defined in your configuration. The agent receives the file content and prompt, then processes it according to its instructions and capabilities.

### Multi-Agent Pipeline

```json
{
  "sources": [
    {
      "input": "./interviews/**/*.wav",
      "output": "./interview-transcripts/",
      "prompt": "InterviewTranscriber",
      "agent": "transcriber"
    },
    {
      "input": "./interview-transcripts/**/*.mdx",
      "output": "./interview-insights/",
      "prompt": "InsightExtractor", 
      "agent": "analyst"
    }
  ]
}
```

This assigns transcription to a "transcriber" agent and analysis to an "analyst" agent, each specialized for their respective tasks.

---

## Embedding Generation from Processed Media

### Audio Embeddings

```json
{
  "embedSources": [
    {
      "input": "./podcasts/**/*.mp3",
      "output": ".knowhow/embeddings/podcasts.json",
      "chunkSize": 2000,
      "prompt": "PodcastEmbeddingExplainer"
    }
  ]
}
```

Audio files are automatically transcribed using `convertAudioToText()`, then chunked and embedded for semantic search.

### Video Embeddings

```json
{
  "embedSources": [
    {
      "input": "./tutorials/**/*.mp4", 
      "output": ".knowhow/embeddings/tutorials.json",
      "chunkSize": 1500
    }
  ]
}
```

Video files are processed using `convertVideoToText()` to extract both visual and audio content, then embedded for search.

### PDF Document Embeddings

```json
{
  "embedSources": [
    {
      "input": "./documentation/**/*.pdf",
      "output": ".knowhow/embeddings/docs.json", 
      "chunkSize": 2000,
      "prompt": "DocumentChunker"
    }
  ]
}
```

---

## Pipeline Chaining Examples

### Complete Media Processing Workflow

```json
{
  "sources": [
    {
      "input": "./raw-content/**/*.{mp4,mp3,pdf}",
      "output": "./processed-content/",
      "prompt": "ContentProcessor"
    },
    {
      "input": "./processed-content/**/*.mdx",
      "output": "./content-categories/",
      "prompt": "ContentCategorizer"
    },
    {
      "input": "./content-categories/**/*.mdx",
      "output": "./final-report.md",
      "prompt": "ReportGenerator"
    }
  ]
}
```

This three-stage pipeline:
1. Processes mixed media files (video, audio, PDF) into text summaries
2. Categorizes the processed content  
3. Generates a final consolidated report

### Meeting-to-Tasks Pipeline

```json
{
  "sources": [
    {
      "input": "./weekly-meetings/**/*.mov",
      "output": "./meeting-transcripts/",
      "prompt": "MeetingTranscriber"
    },
    {
      "input": "./meeting-transcripts/**/*.mdx", 
      "output": "./extracted-tasks/",
      "prompt": "TaskExtractor"
    },
    {
      "input": "./extracted-tasks/**/*.mdx",
      "output": "./project-tasks.json",
      "prompt": "TaskConsolidator",
      "agent": "patcher"
    }
  ]
}
```

---

## Processing Workflow Details

### Transcript Caching and Reuse

The system implements intelligent caching for audio/video processing:

**Audio Processing (`processAudio()`):**
- Transcripts saved as `transcript.json` in `{dir}/{filename}/transcript.json`
- Uses `reusePreviousTranscript` parameter (default: true)
- Checks if transcript exists with `fileExists()` before reprocessing
- Enables fast re-processing with different prompts

**Video Processing (`processVideo()`):**
- Audio transcripts cached the same way as audio files
- Video analysis cached as `video.json` in `{dir}/{filename}/video.json`
- Keyframes extracted using `Downloader.extractKeyframes()`

### Chunking Behavior

**Audio Files:**
- Default chunk time: 30 seconds (configurable via `chunkTime` parameter)
- Uses `Downloader.chunk()` to split audio files
- Each chunk transcribed separately then combined with timestamps

**Video Files:**
- Same 30-second default chunking for audio track
- Keyframes extracted at chunk intervals
- Visual and audio analysis combined per chunk

### Output Structure

**Multi-Output (directory ending with `/`):**
- Creates one output file per input file
- Preserves directory structure relative to input pattern
- Uses `outputExt` (default: "mdx") for file extensions
- Uses `outputName` or original filename

**Single Output (specific filename):**
- Combines all input files into one output
- Useful for reports, summaries, and consolidated documents

---

## Troubleshooting

### Common Issues

**Audio/Video Processing Fails:**
- Ensure ffmpeg is installed and accessible (required by Downloader)
- Check file permissions and disk space
- Verify audio/video files aren't corrupted
- Check that `Downloader.chunk()` and `Downloader.transcribeChunks()` are working

**PDF Processing Fails:**
- Some PDFs may have restrictions or encryption
- Scanned PDFs without OCR won't extract text properly with `pdf-parse`
- Large PDFs may cause memory issues when loading with `fs.readFileSync()`
- Ensure PDF file isn't corrupted

**Pipeline Chaining Issues:**
- Ensure output directory of one stage matches input pattern of next stage
- Check that intermediate files are being created successfully
- Verify file extensions match between stages (default: .mdx)

**Agent Assignment Problems:**
- Ensure the specified agent exists in your configuration
- Check that the agent has appropriate permissions and tools
- Verify the agent can handle the specific prompt and content type

### Performance Optimization

**Large File Processing:**
- Audio/video files are automatically chunked (30s default) for efficient processing
- Consider adjusting `chunkTime` parameter for very long recordings
- Transcript caching avoids reprocessing unchanged files

**Batch Processing:**
- Process files in smaller batches if memory becomes an issue
- Use specific file patterns rather than overly broad glob patterns
- Consider processing different file types in separate pipeline stages

**File System Considerations:**
- Transcripts create subdirectories: `{filename}/transcript.json`
- Video processing creates: `{filename}/video.json`
- Ensure sufficient disk space for intermediate files