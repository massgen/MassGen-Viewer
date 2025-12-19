/**
 * MassGen Session Viewer
 * Fetches and displays MassGen session data from GitHub Gist
 */

// Global state
let sessionData = {};

/**
 * Simple YAML parser for basic YAML structures
 * Handles key: value, nested objects, and arrays
 */
function parseYaml(yamlStr) {
    const result = {};
    const lines = yamlStr.split('\n');
    const stack = [{ obj: result, indent: -2, key: null }];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip empty lines and comments
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const indent = line.search(/\S/);
        const content = line.trim();

        // Pop stack to find parent at correct indent level
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        const parentInfo = stack[stack.length - 1];
        let parent = parentInfo.obj;

        // Handle array items (lines starting with -)
        if (content.startsWith('- ')) {
            const afterDash = content.slice(2);

            // Check if this is "- key: value" format
            const colonIdx = afterDash.indexOf(':');
            if (colonIdx > 0) {
                const key = afterDash.slice(0, colonIdx).trim();
                const value = afterDash.slice(colonIdx + 1).trim();

                // Ensure parent is an array
                if (!Array.isArray(parent)) {
                    // Find the key that should be an array
                    const grandparent = stack.length > 1 ? stack[stack.length - 2].obj : result;
                    const lastKey = parentInfo.key;
                    if (lastKey && grandparent[lastKey] !== undefined) {
                        grandparent[lastKey] = [];
                        parent = grandparent[lastKey];
                        stack[stack.length - 1] = { obj: parent, indent: parentInfo.indent, key: lastKey };
                    }
                }

                // Create new object for array item
                const newObj = {};
                newObj[key] = value === '' ? {} : parseYamlValue(value);

                if (Array.isArray(parent)) {
                    parent.push(newObj);
                    // Push the new object for nested properties
                    stack.push({ obj: newObj, indent: indent + 2, key: key });
                }
            } else {
                // Simple array item like "- value"
                const value = parseYamlValue(afterDash.trim());
                if (Array.isArray(parent)) {
                    parent.push(value);
                }
            }
            continue;
        }

        // Handle key: value
        const colonIdx = content.indexOf(':');
        if (colonIdx > 0) {
            const key = content.slice(0, colonIdx).trim();
            const value = content.slice(colonIdx + 1).trim();

            if (value === '' || value === null) {
                // Nested object or will become array
                parent[key] = {};
                stack.push({ obj: parent[key], indent: indent, key: key });
            } else {
                parent[key] = parseYamlValue(value);
            }
        }
    }

    return result;
}

function parseYamlValue(str) {
    if (str === '' || str === undefined) return null;
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (str === 'null' || str === '~') return null;
    if (/^-?\d+$/.test(str)) return parseInt(str, 10);
    if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str);
    // Remove quotes
    if ((str.startsWith("'") && str.endsWith("'")) ||
        (str.startsWith('"') && str.endsWith('"'))) {
        return str.slice(1, -1);
    }
    return str;
}

/**
 * Parse URL parameters
 */
function getGistId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('gist');
}

/**
 * Unflatten file paths from gist format
 * e.g., "agent_a__timestamp__answer.txt" -> "agent_a/timestamp/answer.txt"
 */
function unflattenPath(flatName) {
    return flatName.replace(/__/g, '/');
}

/**
 * Show error message
 */
function showError(message) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    document.getElementById('error-message').textContent = message;
}

/**
 * Show content
 */
function showContent() {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
}

/**
 * Fetch gist data from GitHub API
 */
async function fetchGist(gistId) {
    const response = await fetch(`https://api.github.com/gists/${gistId}`);

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Session not found. The link may be invalid or the session may have been deleted.');
        }
        throw new Error(`Failed to load session (HTTP ${response.status})`);
    }

    return response.json();
}

/**
 * Parse gist files into structured data
 * Note: GitHub API truncates content for large files, so we fetch from raw_url when needed
 */
async function parseGistFiles(gist) {
    const files = {};

    console.log('=== parseGistFiles Debug ===');
    console.log('Gist files count:', Object.keys(gist.files).length);

    // Collect promises for files that need to be fetched from raw_url
    const fetchPromises = [];

    for (const [filename, fileData] of Object.entries(gist.files)) {
        const path = unflattenPath(filename);

        // Check if content is truncated (GitHub API sets truncated=true for large files)
        if (fileData.truncated || !fileData.content) {
            console.log('File truncated, fetching from raw_url:', filename);
            fetchPromises.push(
                fetch(fileData.raw_url)
                    .then(r => r.text())
                    .then(content => ({ filename, path, content }))
                    .catch(e => {
                        console.log('Failed to fetch raw content:', filename, e);
                        return { filename, path, content: '' };
                    })
            );
        } else {
            // Process inline content
            const content = fileData.content;
            processFileContent(files, filename, path, content);
        }
    }

    // Wait for all truncated files to be fetched
    if (fetchPromises.length > 0) {
        const fetchedFiles = await Promise.all(fetchPromises);
        for (const { filename, path, content } of fetchedFiles) {
            processFileContent(files, filename, path, content);
        }
    }

    console.log('All parsed file paths:', Object.keys(files));
    console.log('=== End parseGistFiles Debug ===');

    return files;
}

/**
 * Process file content and add to files object
 */
function processFileContent(files, filename, path, content) {
    // Try to parse JSON files
    if (filename.endsWith('.json')) {
        try {
            files[path] = JSON.parse(content);
            console.log('Parsed JSON:', path);
        } catch {
            files[path] = content;
            console.log('Failed to parse JSON:', path);
        }
    } else if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
        // Try to parse YAML files
        console.log('Parsing YAML:', path);
        console.log('Raw YAML content (first 500 chars):', content.substring(0, 500));
        try {
            const parsed = parseYaml(content);
            console.log('Parsed YAML result:', parsed);
            files[path] = parsed;
            files[path]._raw = content; // Keep raw for display
        } catch (e) {
            console.log('Failed to parse YAML:', path, e);
            files[path] = content;
        }
    } else {
        files[path] = content;
    }
}

/**
 * Extract agent info from path - handles both old and new formats
 * Old: agent_a/timestamp/answer.txt
 * New: turn_1/attempt_1/agent_a/timestamp/answer.txt
 */
function extractAgentFromPath(path) {
    const parts = path.split('/');
    // Skip turn_X/attempt_Y prefixes if present
    let startIdx = 0;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('turn_') || parts[i].startsWith('attempt_')) {
            startIdx = i + 1;
        } else {
            break;
        }
    }
    const agentId = parts[startIdx] || null;
    const timestamp = parts[startIdx + 1] || null;
    return { agentId, timestamp, startIdx };
}

/**
 * Extract session data from parsed files
 */
function extractSessionData(files) {
    console.log('=== extractSessionData Debug ===');
    console.log('Input files count:', Object.keys(files).length);

    // Look for metrics/status files with various path patterns
    let metrics = {};
    let status = {};
    let coordination = {};
    let snapshotMappings = {};

    for (const [path, content] of Object.entries(files)) {
        if (path.endsWith('metrics_summary.json') && typeof content === 'object') {
            console.log('Found metrics_summary.json at:', path);
            metrics = content;
        }
        if (path.endsWith('status.json') && typeof content === 'object') {
            console.log('Found status.json at:', path);
            status = content;
        }
        if (path.endsWith('coordination_events.json') && typeof content === 'object') {
            console.log('Found coordination_events.json at:', path);
            coordination = content;
        }
        if (path.endsWith('snapshot_mappings.json') && typeof content === 'object') {
            console.log('Found snapshot_mappings.json at:', path);
            snapshotMappings = content;
        }
        if (path.endsWith('execution_metadata.yaml')) {
            console.log('Found execution_metadata.yaml at:', path, 'type:', typeof content);
        }
    }

    console.log('metrics:', metrics);
    console.log('status:', status);
    console.log('coordination keys:', Object.keys(coordination));

    // Build session summary
    const meta = metrics.meta || {};
    const statusMeta = status.meta || {};
    const totals = metrics.totals || {};
    const sessionMeta = coordination.session_metadata || {};

    const question = meta.question || statusMeta.question || sessionMeta.user_prompt || 'Unknown';
    const winner = meta.winner || status.results?.winner || sessionMeta.final_winner;

    // Get timestamps
    const startTime = statusMeta.start_time || sessionMeta.start_time;
    const endTime = sessionMeta.end_time;
    let durationSeconds = null;
    if (startTime && endTime) {
        durationSeconds = endTime - startTime;
    } else if (statusMeta.elapsed_seconds) {
        durationSeconds = statusMeta.elapsed_seconds;
    }

    // Extract answers from files
    const answers = {};
    for (const [path, content] of Object.entries(files)) {
        if (path.includes('/answer.txt') && typeof content === 'string') {
            const { agentId, timestamp } = extractAgentFromPath(path);
            if (agentId && timestamp) {
                const label = `${agentId}.${timestamp}`;
                answers[label] = {
                    label,
                    agent_id: agentId,
                    timestamp: timestamp,  // Store timestamp for workspace matching
                    content: content,
                    type: path.includes('final/') || path.includes('/final/') ? 'final_answer' : 'answer'
                };
            }
        }
    }

    // Extract votes from files - collect ALL votes per agent
    const votes = {};
    for (const [path, content] of Object.entries(files)) {
        if (path.endsWith('/vote.json') && typeof content === 'object') {
            const { agentId, timestamp } = extractAgentFromPath(path);
            if (agentId) {
                if (!votes[agentId]) {
                    votes[agentId] = [];
                }
                votes[agentId].push({
                    agent_id: agentId,
                    voter_id: content.voter_id || agentId,
                    voted_for: content.voted_for,
                    voted_for_label: content.voted_for_label,
                    voted_for_anon: content.voted_for_anon,
                    reason: content.reason,
                    timestamp: timestamp || '',
                    coordination_round: content.coordination_round,
                    available_options: content.available_options || [],
                    agent_mapping: content.agent_mapping || {}
                });
            }
        }
    }
    // Sort votes by coordination_round or timestamp
    for (const agentId of Object.keys(votes)) {
        votes[agentId].sort((a, b) => (a.coordination_round || 0) - (b.coordination_round || 0));
    }

    // Extract agent outputs (excluding _latest files)
    // Paths like: turn_1/attempt_1/agent_outputs/agent_a.txt or agent_outputs/agent_a.txt
    const agentOutputs = {};
    for (const [path, content] of Object.entries(files)) {
        if (path.includes('agent_outputs/') && path.endsWith('.txt')) {
            const parts = path.split('/');
            const filename = parts[parts.length - 1].replace('.txt', '');
            // Skip system_status and _latest files
            if (filename !== 'system_status' && !filename.endsWith('_latest')) {
                agentOutputs[filename] = content;
            }
        }
    }

    // Extract execution metadata (config)
    let executionMetadata = null;
    for (const [path, content] of Object.entries(files)) {
        if (path.includes('execution_metadata') && typeof content === 'object') {
            executionMetadata = content;
            break;
        }
    }

    // Extract workspace files from any agent directory
    // Handle paths with turn_X/attempt_Y prefix
    // Paths like: turn_1/attempt_1/agent_a/timestamp/workspace/file.txt
    //         or: turn_1/attempt_1/final/agent_a/workspace/file.txt
    //         or: agent_a/timestamp/workspace/file.txt
    // Key by agentId/timestamp so we can associate with specific answers
    const workspaceFiles = {};  // { agentId: { timestamp: { filePath: content } } }
    for (const [path, content] of Object.entries(files)) {
        if (path.includes('/workspace/') && typeof content === 'string') {
            // Extract everything after 'workspace/'
            const wsIdx = path.indexOf('/workspace/');
            const relativePath = path.substring(wsIdx + 11); // Skip '/workspace/'

            // Extract agent ID and timestamp from path
            const { agentId, timestamp } = extractAgentFromPath(path);

            if (agentId && relativePath) {
                if (!workspaceFiles[agentId]) {
                    workspaceFiles[agentId] = {};
                }
                // Use timestamp if available, otherwise 'final' or 'default'
                const tsKey = timestamp || (path.includes('/final/') ? 'final' : 'default');
                if (!workspaceFiles[agentId][tsKey]) {
                    workspaceFiles[agentId][tsKey] = {};
                }
                workspaceFiles[agentId][tsKey][relativePath] = content;
            }
        }
    }

    // Count agents from various sources
    const agentSources = new Set();
    Object.keys(metrics.agents || {}).forEach(id => agentSources.add(id));
    Object.keys(status.agents || {}).forEach(id => agentSources.add(id));
    (coordination.events || []).forEach(e => e.agent_id && agentSources.add(e.agent_id));
    // From execution metadata raw YAML
    if (executionMetadata?._raw) {
        const idMatches = executionMetadata._raw.matchAll(/- id: (\S+)/g);
        for (const m of idMatches) agentSources.add(m[1]);
    }

    return {
        metrics,
        status,
        coordination,
        snapshotMappings,
        executionMetadata,
        workspaceFiles,
        session: {
            question,
            winner,
            startTime,
            durationSeconds,
            cost: totals.estimated_cost || 0,
            inputTokens: totals.input_tokens || 0,
            outputTokens: totals.output_tokens || 0,
            reasoningTokens: totals.reasoning_tokens || 0,
            totalToolCalls: metrics.tools?.total_calls || 0,
            totalRounds: metrics.rounds?.total_rounds || 0,
            numAgents: meta.num_agents || agentSources.size || Object.keys(metrics.agents || {}).length
        },
        answers,
        votes,
        agentOutputs,
        files
    };
}

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Format number with commas
 */
function formatNumber(num) {
    return num.toLocaleString();
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Render the session header
 */
function renderHeader(data) {
    document.getElementById('question').textContent = data.session.question;
    document.getElementById('date').textContent = data.session.startTime
        ? new Date(data.session.startTime * 1000).toLocaleString()
        : 'N/A';
    document.getElementById('duration').textContent = formatDuration(data.session.durationSeconds);
    document.getElementById('cost').textContent = `$${data.session.cost.toFixed(4)}`;
    document.getElementById('winner').textContent = data.session.winner || 'N/A';
}

/**
 * Render stats grid
 */
function renderStats(data) {
    const totalTokens = data.session.inputTokens + data.session.outputTokens + data.session.reasoningTokens;

    document.getElementById('stat-cost').textContent = `$${data.session.cost.toFixed(2)}`;
    document.getElementById('stat-tokens').textContent = formatNumber(totalTokens);
    document.getElementById('stat-tools').textContent = data.session.totalToolCalls;
    document.getElementById('stat-rounds').textContent = data.session.totalRounds;
    document.getElementById('stat-agents').textContent = data.session.numAgents;
}

/**
 * Render agent cards
 */
function renderAgents(data) {
    const container = document.getElementById('agents-container');
    const agents = data.metrics.agents || {};
    const statusAgents = data.status.agents || {};
    const winner = data.session.winner;

    // Debug logging
    console.log('=== Agent Debug ===');
    console.log('metrics.agents:', agents);
    console.log('status.agents:', statusAgents);
    console.log('executionMetadata:', data.executionMetadata);
    console.log('executionMetadata.config:', data.executionMetadata?.config);
    console.log('executionMetadata.config.agents:', data.executionMetadata?.config?.agents);

    // Also try to get agent list from execution metadata config
    let configAgents = [];
    if (data.executionMetadata?.config?.agents) {
        const cfgAgents = data.executionMetadata.config.agents;
        console.log('cfgAgents type:', typeof cfgAgents, Array.isArray(cfgAgents));
        console.log('cfgAgents value:', cfgAgents);
        configAgents = Array.isArray(cfgAgents) ? cfgAgents : Object.values(cfgAgents);
        console.log('configAgents after conversion:', configAgents);
    }

    // Fallback: try to extract agents from raw YAML if parsing didn't work
    if (configAgents.length === 0 && data.executionMetadata?._raw) {
        console.log('Falling back to raw YAML extraction');
        const rawYaml = data.executionMetadata._raw;
        // Look for patterns like "- id: agent_a" followed by "model: xxx"
        const agentMatches = rawYaml.matchAll(/- id: (\S+)[\s\S]*?model: (\S+)/g);
        for (const match of agentMatches) {
            console.log('Found agent in raw YAML:', match[1], match[2]);
            configAgents.push({
                id: match[1],
                backend: { model: match[2] }
            });
        }
    }

    // Also try coordination events for agent IDs
    const coordAgentIds = new Set();
    if (data.coordination?.events) {
        data.coordination.events.forEach(e => {
            if (e.agent_id) coordAgentIds.add(e.agent_id);
        });
    }
    console.log('coordAgentIds:', [...coordAgentIds]);

    // Collect all agent IDs from various sources
    const allAgentIds = new Set([
        ...Object.keys(agents),
        ...Object.keys(statusAgents),
        ...configAgents.map(a => a?.id).filter(Boolean),
        ...coordAgentIds
    ]);

    console.log('allAgentIds:', [...allAgentIds]);
    console.log('=== End Agent Debug ===');

    if (allAgentIds.size === 0) {
        container.innerHTML = '<div class="no-data">No agent data available</div>';
        return;
    }

    let html = '';
    for (const agentId of Array.from(allAgentIds).sort()) {
        const agentMetrics = agents[agentId] || {};
        // Get config info for this agent
        const agentConfig = configAgents.find(a => a?.id === agentId) || {};
        const agentStatus = statusAgents[agentId] || {};
        const isWinner = agentId === winner;

        const tokenUsage = agentMetrics.token_usage || agentStatus.token_usage || {};
        const inputTokens = tokenUsage.input_tokens || 0;
        const outputTokens = tokenUsage.output_tokens || 0;
        const cost = tokenUsage.estimated_cost || 0;
        const status = agentStatus.status || (Object.keys(agentMetrics).length > 0 ? 'completed' : 'unknown');
        const answerCount = agentStatus.answer_count || agentMetrics.round_history?.length || 0;
        const model = agentConfig.backend?.model || 'unknown';

        let voteInfo = 'N/A';
        if (agentStatus.vote_cast) {
            voteInfo = `Voted for: ${agentStatus.vote_cast.voted_for_label || agentStatus.vote_cast.voted_for_agent || ''}`;
        }

        html += `
            <div class="agent-card ${isWinner ? 'winner' : ''}">
                <div class="agent-header">
                    <span class="agent-id">${escapeHtml(agentId)}</span>
                    ${isWinner ? '<span class="winner-badge">Winner</span>' : ''}
                </div>
                <div class="agent-model">${escapeHtml(model)}</div>
                <div class="agent-stats">
                    <div class="agent-stat">
                        <span class="agent-stat-label">Status</span>
                        <span class="agent-stat-value">${escapeHtml(status)}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Rounds</span>
                        <span class="agent-stat-value">${answerCount}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Input Tokens</span>
                        <span class="agent-stat-value">${formatNumber(inputTokens)}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Output Tokens</span>
                        <span class="agent-stat-value">${formatNumber(outputTokens)}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Cost</span>
                        <span class="agent-stat-value">$${cost.toFixed(4)}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Vote</span>
                        <span class="agent-stat-value">${escapeHtml(voteInfo)}</span>
                    </div>
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Render tools breakdown
 */
function renderTools(data) {
    const container = document.getElementById('tools-container');
    const tools = data.metrics.tools?.by_tool || {};

    if (Object.keys(tools).length === 0) {
        container.innerHTML = '<div class="no-data">No tool data available</div>';
        return;
    }

    // Sort by execution time
    const sortedTools = Object.entries(tools)
        .map(([name, data]) => ({
            name,
            calls: data.call_count || 0,
            timeMs: data.total_execution_time_ms || 0
        }))
        .sort((a, b) => b.timeMs - a.timeMs)
        .slice(0, 10);

    const maxTime = Math.max(...sortedTools.map(t => t.timeMs), 1);

    let html = '';
    for (const tool of sortedTools) {
        const barWidth = (tool.timeMs / maxTime * 100);
        const timeStr = tool.timeMs < 1000 ? `${tool.timeMs.toFixed(0)}ms` : `${(tool.timeMs / 1000).toFixed(1)}s`;

        html += `
            <div class="tool-bar">
                <span class="tool-name">${escapeHtml(tool.name)}</span>
                <div class="tool-bar-container">
                    <div class="tool-bar-fill" style="width: ${barWidth}%"></div>
                </div>
                <span class="tool-stats">${tool.calls} calls, ${timeStr}</span>
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Render coordination graph - vertical timeline with columns per agent
 * Shows chronological rows with answers/votes, with context backpointers
 */
function renderTimeline(data) {
    const container = document.getElementById('timeline-container');
    const events = data.coordination.events || [];

    // Filter to only answers, votes, and final answer
    const graphEvents = events.filter(e =>
        e.event_type === 'new_answer' ||
        e.event_type === 'vote_cast' ||
        e.event_type === 'final_answer'
    );

    // Deduplicate final_answer events by agent_id (keep only the first one per agent)
    const seenFinalAgents = new Set();
    const dedupedEvents = graphEvents.filter(e => {
        if (e.event_type === 'final_answer') {
            const key = e.agent_id || 'unknown';
            if (seenFinalAgents.has(key)) return false;
            seenFinalAgents.add(key);
        }
        return true;
    });

    if (dedupedEvents.length === 0) {
        container.innerHTML = '<div class="no-data">No coordination events available</div>';
        return;
    }

    const startTime = data.coordination.session_metadata?.start_time || events[0]?.timestamp || 0;

    // Collect all unique agents
    const agentSet = new Set();
    dedupedEvents.forEach(e => {
        if (e.agent_id) agentSet.add(e.agent_id);
    });
    const agents = Array.from(agentSet).sort();

    // Create agent to column index mapping and agent to number mapping (for X.Y labels)
    const agentToCol = {};
    const agentToNum = {};  // agent_a -> 1, agent_b -> 2
    agents.forEach((agent, idx) => {
        agentToCol[agent] = idx;
        agentToNum[agent] = idx + 1;  // 1-indexed for display
    });

    // Sort events by timestamp to create chronological rows
    const sortedEvents = [...dedupedEvents].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Build answer label mapping for context references
    const answerLabelToRowCol = {}; // label -> { row, col, agentId, displayLabel }
    const answerCountByAgent = {}; // agent -> count for generating labels

    // First pass: assign labels to answers and build mapping
    sortedEvents.forEach((event, rowIdx) => {
        if (event.event_type === 'new_answer') {
            const agentId = event.agent_id || 'unknown';
            if (!answerCountByAgent[agentId]) answerCountByAgent[agentId] = 0;
            answerCountByAgent[agentId]++;
            // Use X.Y format where X is agent number (1, 2) and Y is answer count
            const agentNum = agentToNum[agentId] || 1;
            const displayLabel = `${agentNum}.${answerCountByAgent[agentId]}`;
            // Keep original label for internal tracking
            const internalLabel = event.context?.answer_label || `${agentId}.${answerCountByAgent[agentId]}`;
            answerLabelToRowCol[displayLabel] = {
                row: rowIdx,
                col: agentToCol[agentId] ?? 0,
                agentId,
                displayLabel,
                internalLabel
            };
        }
    });

    // Build rows data with context info
    const rows = sortedEvents.map((event, rowIdx) => {
        const agentId = event.agent_id || 'unknown';
        const relTime = ((event.timestamp || 0) - startTime).toFixed(1);
        const col = agentToCol[agentId] ?? 0;
        const agentNum = agentToNum[agentId] || 1;

        let label = '';
        let contextAnswers = []; // answer labels this one had in context
        let votedForLabel = null;
        let availableOptions = [];

        if (event.event_type === 'new_answer') {
            // Compute display label in X.Y format
            const agentAnswerNum = Object.values(answerLabelToRowCol)
                .filter(info => info.agentId === agentId && info.row <= rowIdx)
                .length;
            label = `${agentNum}.${agentAnswerNum}`;

            // Extract context answers - these are the answers available when this one was created
            // Look for previous answers (use displayLabel)
            for (const [displayLabel, info] of Object.entries(answerLabelToRowCol)) {
                if (info.row < rowIdx) {
                    contextAnswers.push(displayLabel);
                }
            }
        } else if (event.event_type === 'vote_cast') {
            // Convert voted_for agent ID to display label
            const votedForAgentId = event.context?.voted_for || event.details?.match(/voted for\s*(\S+)/i)?.[1] || null;
            if (votedForAgentId) {
                // Find the latest answer from this agent at vote time
                const votedAgentNum = agentToNum[votedForAgentId];
                if (votedAgentNum) {
                    // Count answers from voted agent before this vote
                    const votedAgentAnswerCount = Object.values(answerLabelToRowCol)
                        .filter(info => info.agentId === votedForAgentId && info.row < rowIdx)
                        .length;
                    votedForLabel = `${votedAgentNum}.${votedAgentAnswerCount}`;
                }
            }

            // Get available options - all answers before this vote (use displayLabel)
            for (const [displayLabel, info] of Object.entries(answerLabelToRowCol)) {
                if (info.row < rowIdx) {
                    availableOptions.push(displayLabel);
                }
            }
        } else if (event.event_type === 'final_answer') {
            label = 'final';
        }

        return {
            event,
            agentId,
            col,
            relTime,
            label,
            contextAnswers,
            votedForLabel,
            availableOptions,
            type: event.event_type
        };
    });

    // Generate HTML
    let html = `
        <div class="timeline-vertical-container">
            <svg class="timeline-svg" id="timeline-svg"></svg>
            <div class="timeline-vertical">
                <div class="timeline-header">
                    <div class="timeline-time-col">Time</div>
                    ${agents.map(agent => `<div class="timeline-agent-col">${escapeHtml(agent)}</div>`).join('')}
                </div>
                <div class="timeline-body">
    `;

    // Render each row
    rows.forEach((row, rowIdx) => {
        const cellsHtml = agents.map((agent, colIdx) => {
            if (colIdx !== row.col) {
                return '<div class="timeline-cell empty"></div>';
            }

            // This cell has content
            let cellClass = 'timeline-cell';
            let content = '';

            if (row.type === 'new_answer') {
                cellClass += ' answer-cell';
                content = `
                    <div class="timeline-node answer-node clickable" data-row="${rowIdx}" data-col="${colIdx}" data-label="${escapeHtml(row.label)}" data-agent-id="${escapeHtml(row.agentId)}" onclick="navigateToAnswer('${escapeHtml(row.agentId)}', '${escapeHtml(row.label)}')">
                        <div class="node-bubble answer">
                            <span class="node-icon">💬</span>
                            <span class="node-label">${escapeHtml(row.label)}</span>
                        </div>
                    </div>
                `;
            } else if (row.type === 'vote_cast') {
                cellClass += ' vote-cell';
                content = `
                    <div class="timeline-node vote-node clickable" data-row="${rowIdx}" data-col="${colIdx}" data-voted-for="${escapeHtml(row.votedForLabel || '')}" data-agent-id="${escapeHtml(row.agentId)}" onclick="navigateToVote('${escapeHtml(row.agentId)}')">
                        <div class="node-bubble vote">
                            <span class="node-icon">🗳️</span>
                            <span class="node-label">Vote</span>
                        </div>
                        <div class="vote-target">→ ${escapeHtml(row.votedForLabel || '?')}</div>
                    </div>
                `;
            } else if (row.type === 'final_answer') {
                cellClass += ' final-cell';
                content = `
                    <div class="timeline-node final-node clickable" data-row="${rowIdx}" data-col="${colIdx}" data-agent-id="${escapeHtml(row.agentId)}" onclick="navigateToFinalAnswer()">
                        <div class="node-bubble final">
                            <span class="node-icon">✅</span>
                            <span class="node-label">${escapeHtml(row.label)}</span>
                        </div>
                    </div>
                `;
            }

            return `<div class="${cellClass}">${content}</div>`;
        }).join('');

        html += `
            <div class="timeline-row" data-row="${rowIdx}">
                <div class="timeline-time-col">+${row.relTime}s</div>
                ${cellsHtml}
            </div>
        `;
    });

    html += `
                </div>
            </div>
        </div>
    `;

    // Add legend
    html += `
        <div class="coord-legend">
            <span class="legend-item"><span class="legend-dot answer"></span> Answer</span>
            <span class="legend-item"><span class="legend-dot vote"></span> Vote</span>
            <span class="legend-item"><span class="legend-dot final"></span> Final</span>
            <span class="legend-item"><span class="legend-line context"></span> Context</span>
            <span class="legend-item"><span class="legend-line voted"></span> Voted For</span>
        </div>
    `;

    container.innerHTML = html;

    // Now draw SVG lines for context and votes
    requestAnimationFrame(() => {
        drawTimelineConnections(container, rows, answerLabelToRowCol);
    });
}

/**
 * Draw SVG connection lines between timeline nodes
 */
function drawTimelineConnections(container, rows, answerLabelToRowCol) {
    const svg = container.querySelector('#timeline-svg');
    if (!svg) return;

    const timelineContainer = container.querySelector('.timeline-vertical-container');
    if (!timelineContainer) return;

    // Set SVG size to match container
    const containerRect = timelineContainer.getBoundingClientRect();
    svg.setAttribute('width', containerRect.width);
    svg.setAttribute('height', containerRect.height);

    let svgContent = '';

    // Process each row
    rows.forEach((row, rowIdx) => {
        const sourceNode = container.querySelector(`.timeline-node[data-row="${rowIdx}"]`);
        if (!sourceNode) return;

        const sourceRect = sourceNode.getBoundingClientRect();
        const containerOffset = timelineContainer.getBoundingClientRect();

        // Source point (left side of node)
        const sourceX = sourceRect.left - containerOffset.left;
        const sourceY = sourceRect.top - containerOffset.top + sourceRect.height / 2;

        if (row.type === 'new_answer' && row.contextAnswers.length > 0) {
            // Draw lines to context answers (previous answers this one could see)
            row.contextAnswers.forEach(contextLabel => {
                const targetInfo = answerLabelToRowCol[contextLabel];
                if (!targetInfo) return;

                const targetNode = container.querySelector(`.timeline-node[data-label="${contextLabel}"]`);
                if (!targetNode) return;

                const targetRect = targetNode.getBoundingClientRect();
                const targetX = targetRect.right - containerOffset.left;
                const targetY = targetRect.top - containerOffset.top + targetRect.height / 2;

                // Draw a curved line from source to target
                const midX = (sourceX + targetX) / 2;
                svgContent += `
                    <path class="context-line"
                          d="M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}"
                          fill="none" stroke="rgba(125, 207, 255, 0.3)" stroke-width="1.5"/>
                `;
            });
        } else if (row.type === 'vote_cast') {
            // Draw lines to all available options, with bold line to voted-for
            row.availableOptions.forEach(optLabel => {
                const targetInfo = answerLabelToRowCol[optLabel];
                if (!targetInfo) return;

                const targetNode = container.querySelector(`.timeline-node[data-label="${optLabel}"]`);
                if (!targetNode) return;

                const targetRect = targetNode.getBoundingClientRect();
                const targetX = targetRect.right - containerOffset.left;
                const targetY = targetRect.top - containerOffset.top + targetRect.height / 2;

                const isVotedFor = optLabel === row.votedForLabel;
                const strokeWidth = isVotedFor ? 3 : 1;
                const strokeColor = isVotedFor ? 'rgba(158, 206, 106, 0.9)' : 'rgba(187, 154, 247, 0.25)';

                // Draw curved line
                const midX = (sourceX + targetX) / 2;
                svgContent += `
                    <path class="vote-line ${isVotedFor ? 'voted-for' : ''}"
                          d="M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}"
                          fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>
                `;
            });
        }
    });

    svg.innerHTML = svgContent;
}

/**
 * Show node detail on click
 */
window.showNodeDetail = function(node) {
    const detail = node.querySelector('.node-detail');
    if (detail) {
        const isVisible = detail.style.display !== 'none';
        detail.style.display = isVisible ? 'none' : 'block';
    }
};

/**
 * Navigate to an answer in Agent Activity section
 * @param {string} agentId - The agent ID (e.g., "agent_a")
 * @param {string} answerLabel - The answer label in X.Y format (e.g., "1.2")
 */
window.navigateToAnswer = function(agentId, answerLabel) {
    const container = document.getElementById('answers-container');
    if (!container) return;

    // Click the agent tab to switch to that agent
    const agentTab = container.querySelector(`.agent-tab[data-agent="${agentId}"]`);
    if (agentTab) {
        agentTab.click();
    }

    // Switch to the Answers sub-tab
    setTimeout(() => {
        const panel = container.querySelector(`.agent-panel[data-agent="${agentId}"]`);
        if (panel) {
            const answersSubTab = panel.querySelector('.sub-tab[data-subtab="answers"]');
            if (answersSubTab) {
                answersSubTab.click();
            }
        }

        // Find the answer collapsible with matching label and expand it
        setTimeout(() => {
            const answerCollapsibles = container.querySelectorAll('.answer-collapsible');
            answerCollapsibles.forEach(collapsible => {
                const numSpan = collapsible.querySelector('.answer-num');
                if (numSpan && numSpan.textContent.trim() === answerLabel) {
                    // Expand this collapsible
                    collapsible.classList.add('open');
                    // Scroll into view
                    collapsible.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Add highlight effect
                    collapsible.classList.add('highlight-flash');
                    setTimeout(() => collapsible.classList.remove('highlight-flash'), 2000);
                }
            });
        }, 100);
    }, 50);
};

/**
 * Navigate to votes in Agent Activity section
 * @param {string} agentId - The agent ID
 * @param {number} voteRound - Optional vote round number to expand
 */
window.navigateToVote = function(agentId, voteRound) {
    const container = document.getElementById('answers-container');
    if (!container) return;

    // Click the agent tab
    const agentTab = container.querySelector(`.agent-tab[data-agent="${agentId}"]`);
    if (agentTab) {
        agentTab.click();
    }

    // Switch to the Votes sub-tab
    setTimeout(() => {
        const panel = container.querySelector(`.agent-panel[data-agent="${agentId}"]`);
        if (panel) {
            const votesSubTab = panel.querySelector('.sub-tab[data-subtab="votes"]');
            if (votesSubTab) {
                votesSubTab.click();
            }

            // Expand the latest vote (or specific round if provided)
            setTimeout(() => {
                const voteCollapsibles = panel.querySelectorAll('.vote-collapsible');
                if (voteCollapsibles.length > 0) {
                    // Expand the latest vote (last one)
                    const targetVote = voteCollapsibles[voteCollapsibles.length - 1];
                    targetVote.classList.add('open');
                    targetVote.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Add highlight effect
                    targetVote.classList.add('highlight-flash');
                    setTimeout(() => targetVote.classList.remove('highlight-flash'), 2000);
                }
            }, 100);
        }
    }, 50);
};

/**
 * Navigate to final answer section
 */
window.navigateToFinalAnswer = function() {
    const finalAnswerSection = document.querySelector('.final-answer-section');
    if (finalAnswerSection) {
        finalAnswerSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Add highlight effect
        finalAnswerSection.classList.add('highlight-flash');
        setTimeout(() => finalAnswerSection.classList.remove('highlight-flash'), 2000);
    }
};

/**
 * Render inline workspace files within an answer
 */
function renderInlineWorkspace(agentId, timestamp, workspaceFiles) {
    const fileEntries = Object.entries(workspaceFiles).sort();
    if (fileEntries.length === 0) return '';

    let html = `
        <div class="inline-workspace">
            <div class="inline-workspace-header">
                <span class="inline-ws-icon">📁</span>
                <span class="inline-ws-title">Workspace Files (${fileEntries.length})</span>
            </div>
            <div class="inline-workspace-files">
    `;

    for (const [filePath, content] of fileEntries) {
        const fileExt = filePath.split('.').pop().toLowerCase();
        const fileId = `${agentId}__${timestamp}__${filePath}`.replace(/[^a-zA-Z0-9]/g, '_');
        const sizeStr = content.length > 1024
            ? `${(content.length / 1024).toFixed(1)} KB`
            : `${content.length} B`;

        html += `
            <div class="workspace-file" id="file-${fileId}">
                <div class="workspace-file-header" onclick="toggleWorkspaceFile('${fileId}')">
                    <span class="workspace-file-icon">${getFileIcon(fileExt)}</span>
                    <span class="workspace-file-path">${escapeHtml(filePath)}</span>
                    <span class="workspace-file-size">${sizeStr}</span>
                    <span class="workspace-file-toggle">▶</span>
                </div>
                <div class="workspace-file-content">
                    <div class="workspace-file-actions">
                        <button class="ws-action-btn" onclick="copyWorkspaceFileInline('${fileId}')">
                            📋 Copy
                        </button>
                        <button class="ws-action-btn" onclick="downloadWorkspaceFileInline('${fileId}', '${escapeHtml(filePath)}')">
                            ⬇️ Download
                        </button>
                    </div>
                    <div class="workspace-file-code">
                        <pre>${escapeHtml(content)}</pre>
                    </div>
                </div>
            </div>
        `;
    }

    html += `
            </div>
        </div>
    `;

    return html;
}

/**
 * Render answers and votes - tabbed by agent, then sub-tabs for answers/votes
 */
function renderAnswers(data) {
    const container = document.getElementById('answers-container');
    const answers = data.answers;
    const votes = data.votes; // Now an object of arrays: { agent_id: [vote1, vote2, ...] }
    const winner = data.session.winner;
    const workspaceFiles = data.workspaceFiles || {};

    // Filter out final answers - they're shown in the Final Answer section
    const intermediateAnswers = Object.entries(answers)
        .filter(([label, answer]) => answer.type !== 'final_answer')
        .sort((a, b) => a[0].localeCompare(b[0]));

    if (intermediateAnswers.length === 0) {
        container.innerHTML = '<div class="no-data">No intermediate answers recorded</div>';
        return;
    }

    // Build a map of all answer labels to their content (for vote options display)
    const allAnswerLabels = {};
    intermediateAnswers.forEach(([label, answer]) => {
        // Extract short label like "1.1" from full label
        const shortLabel = extractShortLabel(label);
        allAnswerLabels[shortLabel] = {
            fullLabel: label,
            agentId: answer.agent_id,
            content: answer.content
        };
    });

    // Group answers by agent
    const answersByAgent = {};
    intermediateAnswers.forEach(([label, answer]) => {
        const agentId = answer.agent_id;
        if (!answersByAgent[agentId]) {
            answersByAgent[agentId] = [];
        }
        answersByAgent[agentId].push({ label, answer });
    });

    const agentIds = Object.keys(answersByAgent).sort();

    // Build agent tabs
    let html = '<div class="agent-tabs">';
    agentIds.forEach((agentId, index) => {
        const isWinner = agentId === winner;
        const isFirst = index === 0;
        const answerCount = answersByAgent[agentId].length;
        html += `
            <div class="agent-tab ${isFirst ? 'active' : ''} ${isWinner ? 'winner-tab' : ''}" data-agent="${escapeHtml(agentId)}">
                ${escapeHtml(agentId)}
                ${isWinner ? '<span class="winner-dot"></span>' : ''}
                <span class="tab-count">${answerCount}</span>
            </div>
        `;
    });
    html += '</div>';

    // Build content panels for each agent
    html += '<div class="agent-panels">';
    agentIds.forEach((agentId, agentIndex) => {
        const agentAnswers = answersByAgent[agentId];
        const agentVotes = votes[agentId] || []; // Array of votes
        const agentWorkspaceByTimestamp = workspaceFiles[agentId] || {}; // { timestamp: { filePath: content } }
        const isFirst = agentIndex === 0;

        // Determine agent number (1, 2, etc.) for answer labeling
        const agentNum = agentIndex + 1;

        html += `<div class="agent-panel ${isFirst ? 'active' : ''}" data-agent="${escapeHtml(agentId)}">`;

        // Sub-tabs for Answers and Votes only (workspace is now inside each answer)
        html += `
            <div class="sub-tabs">
                <div class="sub-tab active" data-subtab="answers">
                    Answers <span class="sub-tab-count">${agentAnswers.length}</span>
                </div>
                <div class="sub-tab" data-subtab="votes">
                    Votes ${agentVotes.length > 0 ? `<span class="sub-tab-count">${agentVotes.length}</span>` : ''}
                </div>
            </div>
        `;

        // Answers sub-panel - now includes workspace files for each answer
        html += '<div class="sub-panel active" data-subtab="answers">';
        agentAnswers.forEach(({ label, answer }, idx) => {
            const answerNum = idx + 1;
            const shortLabel = `${agentNum}.${answerNum}`;

            // Get workspace files for this specific answer (by timestamp)
            const answerTimestamp = answer.timestamp || label.split('/').pop()?.split('__')[0];
            const answerWorkspace = agentWorkspaceByTimestamp[answerTimestamp] || {};
            const wsFileCount = Object.keys(answerWorkspace).length;

            html += `
                <div class="collapsible answer-collapsible">
                    <div class="collapsible-header">
                        <span class="answer-num">${escapeHtml(shortLabel)}</span>
                        <span class="answer-label-small">${escapeHtml(label)}</span>
                        ${wsFileCount > 0 ? `<span class="ws-badge" title="Workspace files">📁 ${wsFileCount}</span>` : ''}
                        <span class="collapsible-icon">&#x25BC;</span>
                    </div>
                    <div class="collapsible-content">
                        <div class="answer-text">${escapeHtml(answer.content || 'No content available')}</div>
                        ${wsFileCount > 0 ? renderInlineWorkspace(agentId, answerTimestamp, answerWorkspace) : ''}
                    </div>
                </div>
            `;
        });
        html += '</div>';

        // Votes sub-panel - show ALL votes
        html += '<div class="sub-panel" data-subtab="votes">';
        if (agentVotes.length > 0) {
            // Create fallback agent ID to X.Y label mapping (for old logs without labels)
            const agentToLabelFallback = {};
            agentIds.forEach((aid, aidx) => {
                const agentAnswerCount = answersByAgent[aid]?.length || 1;
                agentToLabelFallback[aid] = `${aidx + 1}.${agentAnswerCount}`;
            });

            agentVotes.forEach((vote, voteIdx) => {
                const votedForRaw = vote.voted_for || 'N/A';
                // Prefer voted_for_label from new logs, fallback to computed label
                const votedForLabel = vote.voted_for_label || agentToLabelFallback[votedForRaw] || votedForRaw;
                const round = vote.coordination_round || (voteIdx + 1);

                // Prefer available_options_labels from new logs, fallback to available_options
                const availableLabels = vote.available_options_labels || [];
                const availableOptions = vote.available_options || [];
                const labelToAgent = vote.answer_label_to_agent || {};

                html += `
                    <div class="collapsible vote-collapsible ${voteIdx === agentVotes.length - 1 ? 'latest-vote' : ''}">
                        <div class="collapsible-header">
                            <span class="vote-round">Round ${round}</span>
                            <span class="vote-choice">→ ${escapeHtml(votedForLabel)}</span>
                            ${voteIdx === agentVotes.length - 1 ? '<span class="latest-badge">Latest</span>' : ''}
                            <span class="collapsible-icon">&#x25BC;</span>
                        </div>
                        <div class="collapsible-content">
                            <div class="vote-options-section">
                                <div class="vote-options-header">Available Options:</div>
                                <div class="vote-options-list">
                `;

                // Use new label format if available, otherwise fall back to old format
                if (availableLabels.length > 0) {
                    // New format: show labels with agent IDs
                    availableLabels.forEach(label => {
                        const agentForLabel = labelToAgent[label] || '';
                        const isSelected = label === votedForLabel || (vote.voted_for_label && label === vote.voted_for_label);
                        html += `
                            <div class="vote-option ${isSelected ? 'voted-for' : ''}">
                                <span class="vote-option-label">${escapeHtml(label)}</span>
                                ${agentForLabel ? `<span class="vote-option-agent">(${escapeHtml(agentForLabel)})</span>` : ''}
                                ${isSelected ? '<span class="vote-option-check">✓</span>' : ''}
                            </div>
                        `;
                    });
                } else {
                    // Old format: show agent IDs with computed labels
                    availableOptions.forEach(opt => {
                        const isSelected = opt === votedForRaw;
                        const optLabel = agentToLabelFallback[opt] || opt;
                        html += `
                            <div class="vote-option ${isSelected ? 'voted-for' : ''}">
                                <span class="vote-option-label">${escapeHtml(optLabel)}</span>
                                <span class="vote-option-agent">(${escapeHtml(opt)})</span>
                                ${isSelected ? '<span class="vote-option-check">✓</span>' : ''}
                            </div>
                        `;
                    });
                }

                html += `
                                </div>
                            </div>
                            <div class="vote-detail">
                                <div class="vote-detail-reason">
                                    <div class="vote-detail-label">Reason:</div>
                                    <div class="vote-reason-text">${escapeHtml(String(vote.reason || 'No reason provided'))}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });
        } else {
            html += '<div class="no-data">No votes recorded for this agent</div>';
        }
        html += '</div>';

        html += '</div>'; // close agent-panel
    });
    html += '</div>';

    container.innerHTML = html;

    // Store workspace files globally for copy/download
    window._workspaceFiles = workspaceFiles;

    // Add click handlers for agent tabs
    container.querySelectorAll('.agent-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const agentId = tab.dataset.agent;
            // Update tabs
            container.querySelectorAll('.agent-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Update panels
            container.querySelectorAll('.agent-panel').forEach(p => p.classList.remove('active'));
            container.querySelector(`.agent-panel[data-agent="${agentId}"]`)?.classList.add('active');
        });
    });

    // Add click handlers for sub-tabs
    container.querySelectorAll('.sub-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const panel = tab.closest('.agent-panel');
            const subtab = tab.dataset.subtab;
            // Update sub-tabs
            panel.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Update sub-panels
            panel.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
            panel.querySelector(`.sub-panel[data-subtab="${subtab}"]`)?.classList.add('active');
        });
    });

    // Add click handlers for collapsibles
    container.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            header.parentElement.classList.toggle('open');
        });
    });
}

/**
 * Extract short label like "1.1" from full answer label
 */
function extractShortLabel(fullLabel) {
    // Try to find pattern like "agent1.1" or similar
    const match = fullLabel.match(/(\d+)\.?(\d+)?$/);
    if (match) {
        return match[2] ? `${match[1]}.${match[2]}` : match[1];
    }
    // Fallback - use last part after dot
    const parts = fullLabel.split('.');
    return parts[parts.length - 1] || fullLabel;
}

/**
 * Render final answer
 */
function renderFinalAnswer(data) {
    const container = document.getElementById('final-answer');

    // Try to find final answer in files
    let finalAnswer = '';
    for (const [path, content] of Object.entries(data.files)) {
        if (path.includes('final/') && path.endsWith('/answer.txt')) {
            finalAnswer = content;
            break;
        }
    }

    if (!finalAnswer) {
        // Try coordination table
        finalAnswer = data.files['coordination_table.txt'] || '';
    }

    container.textContent = finalAnswer || 'No final answer available';
}

/**
 * Render agent outputs
 */
function renderOutputs(data) {
    const container = document.getElementById('outputs-container');
    const outputs = data.agentOutputs;

    if (Object.keys(outputs).length === 0) {
        container.innerHTML = '<div class="no-data">No agent output logs available</div>';
        return;
    }

    let html = '';
    for (const [agentId, output] of Object.entries(outputs).sort()) {
        html += `
            <div class="collapsible">
                <div class="collapsible-header">
                    <span>${escapeHtml(agentId)} Output Log</span>
                    <span class="collapsible-icon">&#x25BC;</span>
                </div>
                <div class="collapsible-content">
                    <div class="agent-log">${escapeHtml(output)}</div>
                </div>
            </div>
        `;
    }

    container.innerHTML = html;

    // Add click handlers
    container.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            header.parentElement.classList.toggle('open');
        });
    });
}

/**
 * Render configuration
 */
function renderConfig(data) {
    const container = document.getElementById('config-container');
    const config = data.executionMetadata;

    if (!config) {
        container.innerHTML = '<div class="no-data">No configuration data available</div>';
        return;
    }

    // Extract key info for summary
    const query = config.query || '';
    const configPath = config.config_path || '';
    const massgenVersion = config.massgen_version || '';
    const gitBranch = config.git?.branch || '';
    const gitCommit = config.git?.commit?.substring(0, 8) || '';

    // Get agent configs - handle both array and object formats
    console.log('=== renderConfig Debug ===');
    console.log('config:', config);
    console.log('config.config:', config.config);
    console.log('config.config?.agents:', config.config?.agents);

    let agents = config.config?.agents || [];
    console.log('agents before Array check:', agents, 'isArray:', Array.isArray(agents));
    if (!Array.isArray(agents)) {
        // Convert object to array if needed
        agents = Object.values(agents);
        console.log('agents after Object.values:', agents);
    }
    console.log('final agents array:', agents);

    // Fallback: extract agents from raw YAML if parsing didn't work
    if (agents.length === 0 && config._raw) {
        console.log('Falling back to raw YAML for config agents');
        const rawYaml = config._raw;
        const agentMatches = [...rawYaml.matchAll(/- id: (\S+)[\s\S]*?model: (\S+)/g)];
        for (const match of agentMatches) {
            console.log('Found agent in raw YAML:', match[1], match[2]);
            agents.push({
                id: match[1],
                backend: { model: match[2] }
            });
        }
    }
    console.log('agents after fallback:', agents);
    console.log('=== End renderConfig Debug ===');

    const agentSummary = agents.length > 0
        ? agents.map(a => {
            const model = a?.backend?.model || 'unknown';
            const id = a?.id || 'agent';
            return `${id}: ${model}`;
        }).join(', ')
        : 'N/A';

    // Display raw YAML or JSON
    const rawContent = config._raw || JSON.stringify(config, null, 2);

    // Extract just the config section for download
    const configOnly = config.config || {};
    const configYaml = generateConfigYaml(configOnly);

    container.innerHTML = `
        <div class="config-summary">
            <div class="config-item"><span class="config-label">Query:</span> ${escapeHtml(query)}</div>
            <div class="config-item"><span class="config-label">Agents:</span> ${escapeHtml(agentSummary)}</div>
            <div class="config-item"><span class="config-label">Version:</span> ${escapeHtml(massgenVersion)}</div>
        </div>
        <div class="config-actions">
            <button class="action-btn secondary" onclick="downloadConfig()">
                1. ⬇️ Download Config
            </button>
            <button class="action-btn" onclick="copyRunCommand()">
                2. 📋 Copy Run Command
            </button>
        </div>
        <p class="config-hint">Download the config first, then copy the run command to try this session yourself.</p>
        <div class="collapsible">
            <div class="collapsible-header">
                <span>Full Execution Metadata</span>
                <span class="collapsible-icon">&#x25BC;</span>
            </div>
            <div class="collapsible-content">
                <pre class="config-block">${escapeHtml(rawContent)}</pre>
            </div>
        </div>
    `;

    // Store for copy/download functions
    window._sessionConfig = {
        query: query,
        configYaml: configYaml,
        rawConfig: configOnly
    };

    container.querySelector('.collapsible-header').addEventListener('click', function() {
        this.parentElement.classList.toggle('open');
    });
}

/**
 * Generate a simple YAML string from config object
 */
function generateConfigYaml(config) {
    // Simple YAML generator for the config
    function toYaml(obj, indent = 0) {
        const spaces = '  '.repeat(indent);
        let yaml = '';

        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined) {
                yaml += `${spaces}${key}: null\n`;
            } else if (Array.isArray(value)) {
                yaml += `${spaces}${key}:\n`;
                for (const item of value) {
                    if (typeof item === 'object' && item !== null) {
                        yaml += `${spaces}- `;
                        const itemYaml = toYaml(item, indent + 2).trimStart();
                        yaml += itemYaml.replace(/^  /, '');
                    } else {
                        yaml += `${spaces}- ${item}\n`;
                    }
                }
            } else if (typeof value === 'object') {
                yaml += `${spaces}${key}:\n`;
                yaml += toYaml(value, indent + 1);
            } else if (typeof value === 'string') {
                // Quote strings that might need it
                if (value.includes(':') || value.includes('#') || value.includes('\n')) {
                    yaml += `${spaces}${key}: "${value.replace(/"/g, '\\"')}"\n`;
                } else {
                    yaml += `${spaces}${key}: ${value}\n`;
                }
            } else {
                yaml += `${spaces}${key}: ${value}\n`;
            }
        }
        return yaml;
    }

    return toYaml(config);
}

/**
 * Copy massgen run command to clipboard
 */
window.copyRunCommand = function() {
    const config = window._sessionConfig;
    if (!config) return;

    // Escape the query for shell
    const escapedQuery = config.query.replace(/'/g, "'\\''");
    // Include config flag - user needs to download and specify their config path
    const command = `uv run massgen run --config ./massgen-config.yaml '${escapedQuery}'`;

    navigator.clipboard.writeText(command).then(() => {
        const btn = document.querySelector('.config-actions .action-btn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.classList.remove('copied');
        }, 2000);
    });
};

/**
 * Download config as YAML file
 */
window.downloadConfig = function() {
    const config = window._sessionConfig;
    if (!config) return;

    const blob = new Blob([config.configYaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'massgen-config.yaml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

/**
 * Render gist link
 */
function renderGistLink(gistId) {
    const container = document.getElementById('gist-link');
    container.innerHTML = `<a href="https://gist.github.com/${gistId}" target="_blank">View raw data on GitHub Gist</a>`;
}

/**
 * Render workspace browser with copy/download functionality
 */
function renderWorkspace(data) {
    const container = document.getElementById('workspace-container');
    if (!container) return;

    const workspaceFiles = data.workspaceFiles;

    if (!workspaceFiles || Object.keys(workspaceFiles).length === 0) {
        container.innerHTML = '<div class="no-data">No workspace files available</div>';
        return;
    }

    // Store files globally for copy/download
    window._workspaceFiles = workspaceFiles;

    let html = '<div class="workspace-browser">';

    for (const [agentId, files] of Object.entries(workspaceFiles).sort()) {
        const fileCount = Object.keys(files).length;
        const fileList = Object.entries(files).sort();

        html += `
            <div class="collapsible workspace-agent">
                <div class="collapsible-header">
                    <span class="workspace-agent-name">${escapeHtml(agentId)}</span>
                    <span class="workspace-file-count">${fileCount} file${fileCount !== 1 ? 's' : ''}</span>
                    <button class="ws-download-all-btn" onclick="event.stopPropagation(); downloadWorkspaceZip('${escapeHtml(agentId)}')">
                        📦 Download All
                    </button>
                    <span class="collapsible-icon">&#x25BC;</span>
                </div>
                <div class="collapsible-content">
                    <div class="workspace-file-list">
        `;

        for (const [filePath, content] of fileList) {
            const fileExt = filePath.split('.').pop().toLowerCase();
            const isCode = ['py', 'js', 'ts', 'json', 'yaml', 'yml', 'sh', 'html', 'css', 'md', 'txt'].includes(fileExt);
            const langClass = isCode ? `language-${fileExt}` : '';
            const fileId = `${agentId}__${filePath}`.replace(/[^a-zA-Z0-9]/g, '_');
            const sizeStr = content.length > 1024
                ? `${(content.length / 1024).toFixed(1)} KB`
                : `${content.length} B`;

            html += `
                <div class="workspace-file" id="file-${fileId}">
                    <div class="workspace-file-header" onclick="toggleWorkspaceFile('${fileId}')">
                        <span class="workspace-file-icon">${getFileIcon(fileExt)}</span>
                        <span class="workspace-file-path">${escapeHtml(filePath)}</span>
                        <span class="workspace-file-size">${sizeStr}</span>
                        <span class="workspace-file-toggle">▶</span>
                    </div>
                    <div class="workspace-file-content">
                        <div class="workspace-file-actions">
                            <button class="ws-action-btn" onclick="copyWorkspaceFile('${escapeHtml(agentId)}', '${escapeHtml(filePath)}')">
                                📋 Copy
                            </button>
                            <button class="ws-action-btn" onclick="downloadWorkspaceFile('${escapeHtml(agentId)}', '${escapeHtml(filePath)}')">
                                ⬇️ Download
                            </button>
                        </div>
                        <div class="workspace-file-code">
                            <pre class="${langClass}">${escapeHtml(content)}</pre>
                        </div>
                    </div>
                </div>
            `;
        }

        html += `
                    </div>
                </div>
            </div>
        `;
    }

    html += '</div>';
    container.innerHTML = html;

    // Add click handlers for agent collapsibles
    container.querySelectorAll('.workspace-agent > .collapsible-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // Don't toggle if clicking on a button
            if (e.target.closest('button')) return;
            header.parentElement.classList.toggle('open');
        });
    });
}

/**
 * Get icon for file extension
 */
function getFileIcon(ext) {
    const icons = {
        'py': '🐍',
        'js': '📜',
        'ts': '📘',
        'json': '📋',
        'yaml': '⚙️',
        'yml': '⚙️',
        'md': '📝',
        'txt': '📄',
        'html': '🌐',
        'css': '🎨',
        'sh': '💻',
    };
    return icons[ext] || '📄';
}

/**
 * Toggle workspace file expansion
 */
window.toggleWorkspaceFile = function(fileId) {
    const fileEl = document.getElementById(`file-${fileId}`);
    if (fileEl) {
        fileEl.classList.toggle('expanded');
    }
};

/**
 * Copy workspace file content
 */
window.copyWorkspaceFile = function(agentId, filePath) {
    const content = window._workspaceFiles?.[agentId]?.[filePath];
    if (!content) return;

    navigator.clipboard.writeText(content).then(() => {
        // Find the button and show feedback
        const fileId = `${agentId}__${filePath}`.replace(/[^a-zA-Z0-9]/g, '_');
        const fileEl = document.getElementById(`file-${fileId}`);
        const btn = fileEl?.querySelector('.ws-action-btn');
        if (btn) {
            const original = btn.innerHTML;
            btn.innerHTML = '✅ Copied!';
            setTimeout(() => { btn.innerHTML = original; }, 1500);
        }
    });
};

/**
 * Download workspace file
 */
window.downloadWorkspaceFile = function(agentId, filePath) {
    const content = window._workspaceFiles?.[agentId]?.[filePath];
    if (!content) return;

    const filename = filePath.split('/').pop();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

/**
 * Copy inline workspace file content (extracts content from the pre element)
 */
window.copyWorkspaceFileInline = function(fileId) {
    const fileEl = document.getElementById(`file-${fileId}`);
    const pre = fileEl?.querySelector('.workspace-file-code pre');
    if (!pre) return;

    navigator.clipboard.writeText(pre.textContent).then(() => {
        const btn = fileEl?.querySelector('.ws-action-btn');
        if (btn) {
            const original = btn.innerHTML;
            btn.innerHTML = '✅ Copied!';
            setTimeout(() => { btn.innerHTML = original; }, 1500);
        }
    });
};

/**
 * Download inline workspace file (extracts content from the pre element)
 */
window.downloadWorkspaceFileInline = function(fileId, filePath) {
    const fileEl = document.getElementById(`file-${fileId}`);
    const pre = fileEl?.querySelector('.workspace-file-code pre');
    if (!pre) return;

    const filename = filePath.split('/').pop();
    const blob = new Blob([pre.textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

/**
 * Download all workspace files for an agent as a zip
 * Uses JSZip library loaded from CDN
 */
window.downloadWorkspaceZip = async function(agentId) {
    const files = window._workspaceFiles?.[agentId];
    if (!files || Object.keys(files).length === 0) return;

    // Check if JSZip is loaded, if not load it
    if (typeof JSZip === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.onload = () => createAndDownloadZip(agentId, files);
        document.head.appendChild(script);
    } else {
        createAndDownloadZip(agentId, files);
    }
};

async function createAndDownloadZip(agentId, files) {
    const zip = new JSZip();

    // Add all files to the zip
    for (const [filePath, content] of Object.entries(files)) {
        zip.file(filePath, content);
    }

    // Generate and download
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agentId}-workspace.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Copy final answer to clipboard
 */
window.copyFinalAnswer = function() {
    const content = document.getElementById('final-answer').textContent;
    navigator.clipboard.writeText(content).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
        }, 2000);
    });
};

/**
 * Main initialization
 */
async function init() {
    const gistId = getGistId();

    if (!gistId) {
        showError('No session ID provided. Add ?gist=YOUR_GIST_ID to the URL. Learn more at https://github.com/massgen/MassGen');
        return;
    }

    try {
        const gist = await fetchGist(gistId);
        const files = await parseGistFiles(gist);
        sessionData = extractSessionData(files);

        // Render all sections
        renderHeader(sessionData);
        renderStats(sessionData);
        renderAgents(sessionData);
        renderTools(sessionData);
        renderTimeline(sessionData);
        renderAnswers(sessionData);
        renderFinalAnswer(sessionData);
        renderWorkspace(sessionData);
        renderOutputs(sessionData);
        renderConfig(sessionData);
        renderGistLink(gistId);

        showContent();

    } catch (error) {
        console.error('Error loading session:', error);
        showError(error.message);
    }
}

// Start the app
init();
