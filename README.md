# MassGen Session Viewer

A static web application for viewing shared MassGen sessions.

## Overview

This viewer fetches MassGen session data from GitHub Gist and displays it in a clean, interactive interface. It's hosted on GitHub Pages and requires no authentication to view shared sessions.

## Usage

Sessions are viewed via URL parameter:

```
https://massgen.github.io/MassGen-Viewer/?gist=YOUR_GIST_ID
```

## Features

### Core Features
- **Session Overview**: Question, duration, cost, winner
- **Stats Dashboard**: Tokens, tool calls, rounds, agents
- **Agent Cards**: Per-agent metrics and status
- **Tools Breakdown**: Tool usage with timing bars
- **Coordination Timeline**: Event-by-event progress
- **Answers & Votes**: Interactive tabs for agent responses
- **Final Answer**: Prominent display with copy button
- **Agent Logs**: Collapsible full output logs
- **Configuration**: Sanitized execution config

### Multi-Turn Session Support
- **Turn Navigation**: Tab-based navigation for multi-turn conversations
- **Per-Turn Filtering**: All sections automatically filter by selected turn
- **Session Manifest**: Parses `_session_manifest.json` for session metadata
- **Turn Status Indicators**: Visual indicators for complete/error/interrupted turns
- **Error State Display**: Shows agent errors and failure details

### Workspace Browser
- **Directory Tree**: Hierarchical file browser with expand/collapse folders
- **File Actions**: Copy content, download individual files, download all as ZIP
- **Turn-Filtered Files**: Workspace files filtered by current turn selection

### Artifact Preview
- **React Bundle Integration**: Uses shared artifact renderers from webui (single source of truth)
- **Supported Types**: HTML, Markdown, SVG, Images (PNG, JPG, GIF, WebP), PDF, Mermaid diagrams, Videos, Office documents (DOCX, PPTX, XLSX)
- **Office Document Preview**: DOCX/PPTX/XLSX files are pre-converted to PDF during `massgen export` for full-fidelity preview
- **Smart Preview**: Clicking "Preview" on an Office file automatically uses the PDF version if available
- **Preview Badge**: Previewable files show a "Preview" badge in the workspace tree
- **Modal Preview**: Click "Preview" button to open full-screen artifact rendering
- **Live Rendering**: HTML artifacts render with CSS/JS support in sandboxed iframes

### Try This Session
- **Download Config**: Get the YAML configuration to run the session locally
- **Copy Run Command**: Quick copy of `massgen run` command
- **Turn 1 Only**: Shown only on first turn for multi-turn sessions

## Local Development

```bash
# Serve locally
npx serve .

# Or with Python
python -m http.server 8000
```

Then visit `http://localhost:8000/?gist=YOUR_GIST_ID`

## How It Works

1. Parses `?gist=ID` from URL
2. Fetches gist via GitHub API (`https://api.github.com/gists/{id}`)
3. Parses flattened file names back to paths
4. Detects multi-turn sessions via `_session_manifest.json`
5. Extracts per-turn metrics, status, answers, votes from files
6. Builds workspace file trees with directory structure
7. Renders interactive UI with turn navigation

## Session Manifest Format

Multi-turn sessions include a `_session_manifest.json` file:

```json
{
  "format_version": "1.0",
  "session_type": "multi_turn",
  "turn_count": 3,
  "turns": [
    {"turn_number": 1, "status": "complete", "question": "..."},
    {"turn_number": 2, "status": "complete", "question": "..."},
    {"turn_number": 3, "status": "error", "question": "..."}
  ],
  "total_cost": 1.234,
  "total_tokens": {"input": 50000, "output": 10000}
}
```

## Architecture

### Artifact Renderers

The viewer uses React-based artifact renderers built from the webui source. This ensures a single source of truth for rendering logic.

**Bundle Structure:**
```
MassGen-Viewer/
├── lib/
│   └── massgen-renderers.umd.js  # Built from webui/src/lib/renderers.ts
└── index.html                     # Loads React 18 CDN + bundle
```

**Dependencies** (loaded via CDN in index.html):
- React 18 (production UMD)
- ReactDOM 18 (production UMD)

## Updating Artifact Renderers

If you make changes to the artifact renderers in `webui/src/components/artifactRenderers/`, you need to rebuild and copy the bundle:

```bash
# 1. Rebuild the UMD bundle
cd webui
npm run build:lib

# 2. Copy to MassGen-Viewer
cp dist/massgen-renderers.umd.js ../MassGen-Viewer/lib/
```

The renderers are exported from `webui/src/lib/renderers.ts`. Supported renderers:
- HtmlPreview, ImagePreview, MarkdownPreview, SvgPreview
- PdfPreview, MermaidPreview, VideoPreview
- DocxPreview, XlsxPreview, PptxPreview, SandpackPreview

## Related

- [MassGen](https://github.com/massgen/MassGen) - Multi-Agent Coordination Framework
- Share sessions: `massgen export --share`
- Manage shares: `massgen shares list`, `massgen shares delete <id>`
