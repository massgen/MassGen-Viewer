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

- **Session Overview**: Question, duration, cost, winner
- **Stats Dashboard**: Tokens, tool calls, rounds, agents
- **Agent Cards**: Per-agent metrics and status
- **Tools Breakdown**: Tool usage with timing bars
- **Coordination Timeline**: Event-by-event progress
- **Answers & Votes**: Interactive tabs for agent responses
- **Final Answer**: Prominent display with copy button
- **Agent Logs**: Collapsible full output logs
- **Configuration**: Sanitized execution config

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
4. Extracts metrics, status, answers, votes from files
5. Renders interactive UI

## Related

- [MassGen](https://github.com/massgen/MassGen) - Multi-Agent Coordination Framework
- Share sessions: `massgen export --share`
- Manage shares: `massgen shares list`, `massgen shares delete <id>`
