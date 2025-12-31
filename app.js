/**
 * MassGen Session Viewer
 * Fetches and displays MassGen session data from GitHub Gist
 *
 * Enhanced for multi-turn session support:
 * - Parses _session_manifest.json for turn navigation
 * - Displays session status (complete/error/interrupted)
 * - Supports turn-by-turn navigation
 */

// Global state
let sessionData = {};
let currentTurn = null; // For multi-turn navigation
let sessionManifest = null; // Parsed from _session_manifest.json

// =============================================================================
// Office Document Helpers (for smart PDF preview)
// =============================================================================

/**
 * Office document extensions that have pre-converted PDF versions
 */
const OFFICE_EXTENSIONS = ['.docx', '.pptx', '.xlsx'];

/**
 * Check if a file is an Office document
 * @param {string} fileName - The file name
 * @returns {boolean}
 */
function isOfficeDocument(fileName) {
    const lowerName = fileName.toLowerCase();
    return OFFICE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

/**
 * Get the PDF version path for an Office document
 * For example: "report.docx" -> "report.docx.pdf"
 * @param {string} filePath - The original file path
 * @returns {string} The PDF version path
 */
function getPdfVersionPath(filePath) {
    return filePath + '.pdf';
}

// =============================================================================
// Session Manifest Functions (Multi-Turn Support)
// =============================================================================

/**
 * Parse the session manifest from _session_manifest.json
 * Returns null if manifest doesn't exist (legacy single-turn gist)
 */
function parseSessionManifest(files) {
    const manifestPath = '_session_manifest.json';
    if (files[manifestPath] && typeof files[manifestPath] === 'object') {
        return files[manifestPath];
    }
    return null;
}

/**
 * Detect if this is a legacy gist (no manifest)
 * Legacy gists have files directly in the root without turn prefixes
 */
function detectLegacyGist(files) {
    // If we have a manifest, it's not legacy
    if (files['_session_manifest.json']) {
        return false;
    }
    // Legacy gists have files like "metrics_summary.json" directly
    // New gists have files like "turn_1/attempt_1/metrics_summary.json"
    for (const path of Object.keys(files)) {
        if (path.startsWith('turn_')) {
            return false;
        }
    }
    return true;
}

/**
 * Get session status from manifest or infer from files
 */
function getSessionStatus(manifest, files) {
    if (manifest && manifest.status) {
        return manifest.status;
    }
    // Infer from files - check for errors in status.json
    for (const [path, content] of Object.entries(files)) {
        if (path.endsWith('status.json') && typeof content === 'object') {
            const rounds = content.rounds?.by_outcome || {};
            if (rounds.error > 0) return 'error';
            if (rounds.timeout > 0) return 'timeout';
        }
    }
    return 'complete';
}

/**
 * Get error info from manifest or status.json
 */
function getErrorInfo(manifest, files) {
    if (manifest && manifest.error) {
        return manifest.error;
    }
    // Try to extract from status.json
    for (const [path, content] of Object.entries(files)) {
        if (path.endsWith('status.json') && typeof content === 'object') {
            const agents = content.agents || {};
            for (const [agentId, agentData] of Object.entries(agents)) {
                if (agentData.error) {
                    return {
                        type: agentData.error.type || 'unknown',
                        message: agentData.error.message || 'Unknown error',
                        agent_id: agentId
                    };
                }
            }
        }
    }
    return null;
}

/**
 * Get turns from manifest
 */
function getTurnsFromManifest(manifest) {
    if (manifest && manifest.turns && Array.isArray(manifest.turns)) {
        return manifest.turns;
    }
    return [];
}

/**
 * Set current turn for filtering data
 */
function setCurrentTurn(turnKey) {
    console.log('[Turn Filter] setCurrentTurn called with:', turnKey);
    currentTurn = turnKey;
    // Update turn tab UI
    updateTurnTabs();
    // Show/hide "Try This Session" based on turn (only show on Turn 1, any attempt)
    const trySection = document.getElementById('try-session-section');
    if (trySection) {
        // turnKey is like "1_1" or "1_2" - extract turn number
        const turnNumber = turnKey ? parseInt(turnKey.split('_')[0], 10) : null;
        trySection.style.display = (turnNumber === 1 || turnKey === null) ? '' : 'none';
    }
    // Re-render turn-dependent sections
    if (sessionData) {
        console.log('[Turn Filter] sessionData exists, perTurnData keys:', Object.keys(sessionData.perTurnData || {}));
        const filteredData = getDataForCurrentTurn(sessionData);
        console.log('[Turn Filter] filtered coordination events:', filteredData.coordination?.events?.length);
        console.log('[Turn Filter] filtered answers:', Object.keys(filteredData.answers || {}));
        renderStats(sessionData);
        renderAgents(sessionData);
        renderTimeline(sessionData);
        renderAnswers(sessionData);
        renderFinalAnswer(sessionData);
        renderOutputs(sessionData);
    } else {
        console.log('[Turn Filter] sessionData is null/undefined');
    }
}

/**
 * Extract turn and attempt info from file path
 * Handles paths like:
 *   - turn_1__attempt_1__status.json (flattened with __)
 *   - turn_1/attempt_1/status.json (nested with /)
 * Returns: { turn: number, attempt: number, key: "turn_attempt" } or null
 */
function extractTurnAttemptFromPath(path) {
    // Match turn_X__attempt_Y__ or turn_X/attempt_Y/
    const match = path.match(/^turn_(\d+)(?:__|\/)+attempt_(\d+)(?:__|\/)/);
    if (match) {
        const turn = parseInt(match[1], 10);
        const attempt = parseInt(match[2], 10);
        return { turn, attempt, key: `${turn}_${attempt}` };
    }
    return null;
}

/**
 * Extract turn number from file path (legacy, for backwards compatibility)
 * Handles paths like:
 *   - turn_1__attempt_1__status.json (flattened with __)
 *   - turn_1/attempt_1/status.json (nested with /)
 */
function extractTurnFromPath(path) {
    const info = extractTurnAttemptFromPath(path);
    return info ? info.turn : null;
}

/**
 * Filter files by current turn (using compound key)
 * Returns all files if currentTurn is null, otherwise only files for that turn+attempt
 */
function filterFilesByTurn(files) {
    if (currentTurn === null) {
        return files;
    }
    const filtered = {};
    for (const [path, content] of Object.entries(files)) {
        const turnAttempt = extractTurnAttemptFromPath(path);
        const fileKey = turnAttempt?.key || null;
        // Include files from the current turn+attempt, or files without turn prefix (legacy)
        if (fileKey === currentTurn || fileKey === null) {
            filtered[path] = content;
        }
    }
    return filtered;
}

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

    // Collect promises for files that need to be fetched from raw_url
    const fetchPromises = [];

    for (const [filename, fileData] of Object.entries(gist.files)) {
        const path = unflattenPath(filename);

        // Check if content is truncated (GitHub API sets truncated=true for large files)
        if (fileData.truncated || !fileData.content) {
            fetchPromises.push(
                fetch(fileData.raw_url)
                    .then(r => r.text())
                    .then(content => ({ filename, path, content }))
                    .catch(() => ({ filename, path, content: '' }))
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
        } catch {
            files[path] = content;
        }
    } else if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
        // Try to parse YAML files
        try {
            const parsed = parseYaml(content);
            files[path] = parsed;
            files[path]._raw = content; // Keep raw for display
        } catch {
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
 * Flattened: turn_1__attempt_1__agent_a__20251228_123456__answer.txt
 */
function extractAgentFromPath(path) {
    // Check if this is a flattened path (uses __ separator)
    if (path.includes('__') && !path.includes('/')) {
        const parts = path.split('__');
        // Pattern: turn_X__attempt_Y__agent_id__timestamp__filename
        // or: turn_X__attempt_Y__final__agent_id__filename
        let agentId = null;
        let timestamp = null;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            // Skip turn_X and attempt_Y
            if (part.startsWith('turn_') || part.startsWith('attempt_')) continue;
            // Skip 'final' marker
            if (part === 'final') continue;
            // Agent IDs typically start with 'agent_' or contain known patterns
            if (part.startsWith('agent_') || part.match(/^[a-z]+_[a-z]$/)) {
                agentId = part;
                // Next part might be timestamp (starts with digit, like 20251228_123456)
                if (i + 1 < parts.length && parts[i + 1].match(/^\d{8}_\d+/)) {
                    timestamp = parts[i + 1];
                }
                break;
            }
        }
        return { agentId, timestamp, startIdx: 0 };
    }

    // Original path-based logic
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
    // Look for metrics/status files with various path patterns
    // Store per-turn data for multi-turn filtering
    let metrics = {};
    let status = {};
    let coordination = {};
    let snapshotMappings = {};

    // Per-turn data storage: { "turn_attempt": { metrics, status, coordination, ... } }
    // e.g., { "1_1": { ... }, "1_2": { ... }, "2_1": { ... } }
    const perTurnData = {};

    for (const [path, content] of Object.entries(files)) {
        const turnAttempt = extractTurnAttemptFromPath(path);
        const dataKey = turnAttempt?.key || null;

        // Initialize per-turn storage if needed
        if (dataKey !== null && !perTurnData[dataKey]) {
            perTurnData[dataKey] = {
                metrics: {},
                status: {},
                coordination: {},
                snapshotMappings: {},
                answers: {},
                votes: {},
                turnNumber: turnAttempt.turn,
                attemptNumber: turnAttempt.attempt
            };
        }

        if (path.endsWith('metrics_summary.json') && typeof content === 'object') {
            metrics = content;
            if (dataKey !== null) perTurnData[dataKey].metrics = content;
        }
        if (path.endsWith('status.json') && typeof content === 'object') {
            status = content;
            if (dataKey !== null) perTurnData[dataKey].status = content;
        }
        if (path.endsWith('coordination_events.json') && typeof content === 'object') {
            coordination = content;
            if (dataKey !== null) perTurnData[dataKey].coordination = content;
        }
        if (path.endsWith('snapshot_mappings.json') && typeof content === 'object') {
            snapshotMappings = content;
            if (dataKey !== null) perTurnData[dataKey].snapshotMappings = content;
        }
    }

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
        // Handle both flattened (turn_1__attempt_1__agent_a__ts__answer.txt) and nested paths
        if ((path.endsWith('__answer.txt') || path.includes('/answer.txt')) && typeof content === 'string') {
            const turnAttempt = extractTurnAttemptFromPath(path);
            const dataKey = turnAttempt?.key || null;
            const { agentId, timestamp } = extractAgentFromPath(path);
            if (agentId && timestamp) {
                const label = `${agentId}.${timestamp}`;
                const answerData = {
                    label,
                    agent_id: agentId,
                    timestamp: timestamp,
                    content: content,
                    turn: turnAttempt?.turn || null,
                    attempt: turnAttempt?.attempt || null,
                    turnKey: dataKey,
                    type: path.includes('final/') || path.includes('__final__') ? 'final_answer' : 'answer'
                };
                answers[label] = answerData;
                // Also store in per-turn data
                if (dataKey !== null && perTurnData[dataKey]) {
                    perTurnData[dataKey].answers[label] = answerData;
                }
            }
        }
    }

    // Extract votes from files - collect ALL votes per agent, with turn info
    const votes = {};
    for (const [path, content] of Object.entries(files)) {
        if ((path.endsWith('/vote.json') || path.endsWith('__vote.json')) && typeof content === 'object') {
            const turnNum = extractTurnFromPath(path);
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
                    agent_mapping: content.agent_mapping || {},
                    turn: turnNum
                });
            }
        }
    }
    // Sort votes by coordination_round or timestamp
    for (const agentId of Object.keys(votes)) {
        votes[agentId].sort((a, b) => (a.coordination_round || 0) - (b.coordination_round || 0));
    }

    // Extract agent outputs (excluding _latest files)
    // Paths like: turn_1/attempt_1/agent_outputs/agent_a.txt or turn_1__attempt_1__agent_outputs__agent_a.txt
    const agentOutputs = {};
    for (const [path, content] of Object.entries(files)) {
        // Handle both nested (/) and flattened (__) path formats
        const isAgentOutput = (path.includes('agent_outputs/') || path.includes('__agent_outputs__')) && path.endsWith('.txt');
        if (isAgentOutput) {
            // Extract filename from either format
            let filename;
            if (path.includes('__agent_outputs__')) {
                // Flattened: turn_1__attempt_1__agent_outputs__agent_a.txt
                const afterOutputs = path.split('__agent_outputs__')[1];
                filename = afterOutputs.replace('.txt', '');
            } else {
                // Nested: turn_1/attempt_1/agent_outputs/agent_a.txt
                const parts = path.split('/');
                filename = parts[parts.length - 1].replace('.txt', '');
            }
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
    // Also handle flattened gist paths with __ separator:
    //         turn_1__attempt_1__final__agent_a__workspace__file.txt
    // Key by agentId/timestamp so we can associate with specific answers
    const workspaceFiles = {};  // { agentId: { timestamp: { filePath: content } } }
    // Also track per-turn workspace files: { turnNumber: { agentId: { timestamp: { filePath: content } } } }
    const turnWorkspaceFiles = {};
    for (const [path, content] of Object.entries(files)) {
        // Check for workspace in both nested (/workspace/) and flattened (__workspace__) formats
        const hasNestedWorkspace = path.includes('/workspace/');
        const hasFlattenedWorkspace = path.includes('__workspace__');

        if ((hasNestedWorkspace || hasFlattenedWorkspace) && typeof content === 'string') {
            let relativePath;

            if (hasNestedWorkspace) {
                // Extract everything after 'workspace/'
                const wsIdx = path.indexOf('/workspace/');
                relativePath = path.substring(wsIdx + 11); // Skip '/workspace/'
            } else {
                // Handle flattened format: extract everything after '__workspace__'
                const wsIdx = path.indexOf('__workspace__');
                relativePath = path.substring(wsIdx + 13).replace(/__/g, '/'); // Skip '__workspace__' and convert __ to /
            }

            // Extract agent ID, timestamp, and turn from path
            const { agentId, timestamp } = extractAgentFromPath(path);
            const turnNum = extractTurnFromPath(path);

            if (agentId && relativePath) {
                if (!workspaceFiles[agentId]) {
                    workspaceFiles[agentId] = {};
                }
                // Use timestamp if available, otherwise 'final' or 'default'
                // Check for 'final' in both formats
                const isFinal = path.includes('/final/') || path.includes('__final__');
                const tsKey = timestamp || (isFinal ? 'final' : 'default');
                if (!workspaceFiles[agentId][tsKey]) {
                    workspaceFiles[agentId][tsKey] = {};
                }
                workspaceFiles[agentId][tsKey][relativePath] = content;

                // Also store in per-turn structure for filtering
                if (turnNum !== null) {
                    if (!turnWorkspaceFiles[turnNum]) {
                        turnWorkspaceFiles[turnNum] = {};
                    }
                    if (!turnWorkspaceFiles[turnNum][agentId]) {
                        turnWorkspaceFiles[turnNum][agentId] = {};
                    }
                    if (!turnWorkspaceFiles[turnNum][agentId][tsKey]) {
                        turnWorkspaceFiles[turnNum][agentId][tsKey] = {};
                    }
                    turnWorkspaceFiles[turnNum][agentId][tsKey][relativePath] = content;
                }
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

    // Parse manifest if available
    const manifest = parseSessionManifest(files);
    const isLegacy = detectLegacyGist(files);
    const sessionStatus = getSessionStatus(manifest, files);
    const errorInfo = getErrorInfo(manifest, files);
    const turns = getTurnsFromManifest(manifest);

    // Store manifest globally
    sessionManifest = manifest;

    // Override question and winner from manifest if available
    const finalQuestion = manifest?.question || question;
    const finalWinner = manifest?.winner || winner;

    return {
        metrics,
        status,
        coordination,
        snapshotMappings,
        executionMetadata,
        workspaceFiles,
        turnWorkspaceFiles,  // Per-turn workspace files for filtering
        manifest,
        isLegacy,
        sessionStatus,
        errorInfo,
        turns,
        perTurnData,  // Per-turn data for filtering
        session: {
            question: finalQuestion,
            winner: finalWinner,
            startTime,
            durationSeconds,
            cost: manifest?.total_cost || totals.estimated_cost || 0,
            inputTokens: manifest?.total_tokens?.input || totals.input_tokens || 0,
            outputTokens: manifest?.total_tokens?.output || totals.output_tokens || 0,
            reasoningTokens: totals.reasoning_tokens || 0,
            totalToolCalls: metrics.tools?.total_calls || 0,
            totalRounds: metrics.rounds?.total_rounds || 0,
            numAgents: manifest?.agents?.length || meta.num_agents || agentSources.size || Object.keys(metrics.agents || {}).length,
            turnCount: manifest?.turn_count || turns.length || 1
        },
        answers,
        votes,
        agentOutputs,
        files
    };
}

/**
 * Get data for the current turn (or all data if no turn selected)
 */
function getDataForCurrentTurn(data) {
    console.log('[getDataForCurrentTurn] currentTurn:', currentTurn, 'type:', typeof currentTurn);
    console.log('[getDataForCurrentTurn] perTurnData keys:', Object.keys(data.perTurnData || {}));
    console.log('[getDataForCurrentTurn] perTurnData[currentTurn]:', data.perTurnData?.[currentTurn]);

    if (currentTurn === null || !data.perTurnData || !data.perTurnData[currentTurn]) {
        console.log('[getDataForCurrentTurn] returning unfiltered data');
        return data;
    }
    const turnData = data.perTurnData[currentTurn];
    console.log('[getDataForCurrentTurn] turnData.coordination events:', turnData.coordination?.events?.length);
    // Get workspace files for this turn, or fall back to all workspace files
    const turnWsFiles = data.turnWorkspaceFiles?.[currentTurn] || data.workspaceFiles;
    return {
        ...data,
        metrics: turnData.metrics || data.metrics,
        status: turnData.status || data.status,
        coordination: turnData.coordination || data.coordination,
        snapshotMappings: turnData.snapshotMappings || data.snapshotMappings,
        answers: turnData.answers || {},
        workspaceFiles: turnWsFiles
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
    // For multi-turn, show first turn's question initially (will be updated by turn selection)
    const isMultiTurn = data.turns && data.turns.length > 1;
    const displayQuestion = isMultiTurn && data.turns[0]?.question
        ? data.turns[0].question
        : data.session.question;

    document.getElementById('question').textContent = displayQuestion;
    document.getElementById('date').textContent = data.session.startTime
        ? new Date(data.session.startTime * 1000).toLocaleString()
        : 'N/A';
    document.getElementById('duration').textContent = formatDuration(data.session.durationSeconds);
    document.getElementById('cost').textContent = `$${data.session.cost.toFixed(4)}`;
    document.getElementById('winner').textContent = data.session.winner || 'N/A';

    // Render session status banner
    renderSessionStatus(data);

    // Render turn navigation if multi-turn
    if (isMultiTurn) {
        // Default to the last (most recent) turn+attempt
        // Find the last turn in the manifest
        const turns = data.manifest?.turns || [];
        if (turns.length > 0) {
            const lastTurn = turns[turns.length - 1];
            currentTurn = `${lastTurn.turn_number}_${lastTurn.attempt_number || 1}`;
        } else {
            // Fallback: find last key in perTurnData
            const keys = Object.keys(data.perTurnData || {}).sort();
            currentTurn = keys.length > 0 ? keys[keys.length - 1] : '1_1';
        }
        renderTurnNavigation(data);
        // Note: "Try This Session" is shown/hidden based on current turn in updateTurnDisplay
    }
}

/**
 * Render session status banner (complete/error/interrupted)
 */
function renderSessionStatus(data) {
    const headerEl = document.querySelector('.session-header');
    if (!headerEl) return;

    // Remove existing status banner if any
    const existingBanner = document.getElementById('session-status-banner');
    if (existingBanner) {
        existingBanner.remove();
    }

    const status = data.sessionStatus || 'complete';
    if (status === 'complete') return; // Don't show banner for complete sessions

    const banner = document.createElement('div');
    banner.id = 'session-status-banner';
    banner.className = `status-banner status-${status}`;

    let icon = '';
    let message = '';
    if (status === 'error') {
        icon = '⚠️';
        message = 'This session ended with an error';
        if (data.errorInfo) {
            message += `: ${data.errorInfo.type || 'unknown'} - ${data.errorInfo.message || 'No details available'}`;
        }
    } else if (status === 'interrupted') {
        icon = '⏸️';
        message = 'This session was interrupted before completion';
    } else if (status === 'timeout') {
        icon = '⏱️';
        message = 'This session timed out';
    }

    banner.innerHTML = `<span class="status-icon">${icon}</span> <span class="status-message">${escapeHtml(message)}</span>`;
    headerEl.insertBefore(banner, headerEl.firstChild);
}

/**
 * Render turn navigation for multi-turn sessions
 */
function renderTurnNavigation(data) {
    const headerEl = document.querySelector('.session-header');
    if (!headerEl) return;

    // Remove existing nav if any
    const existingNav = document.getElementById('turn-navigation');
    if (existingNav) {
        existingNav.remove();
    }

    const nav = document.createElement('div');
    nav.id = 'turn-navigation';
    nav.className = 'turn-navigation';

    // Header - show unique turn count (not attempt count)
    const header = document.createElement('div');
    header.className = 'turn-nav-header';
    const uniqueTurns = data.session?.turnCount || new Set(data.turns.map(t => t.turn_number)).size;
    const totalAttempts = data.turns.length;
    const headerText = uniqueTurns === totalAttempts
        ? `<strong>Turns:</strong> ${uniqueTurns} total`
        : `<strong>Turn${uniqueTurns > 1 ? 's' : ''}:</strong> ${uniqueTurns} (${totalAttempts} attempts)`;
    header.innerHTML = headerText;
    nav.appendChild(header);

    // Turn tabs
    const tabs = document.createElement('div');
    tabs.className = 'turn-tabs';

    // Add individual turn tabs (no "All" tab - session totals are in header)
    for (const turn of data.turns) {
        const tab = document.createElement('button');
        const statusIcon = turn.status === 'complete' ? '✓' :
                           turn.status === 'error' ? '✗' : '○';
        const statusClass = turn.status === 'complete' ? 'complete' :
                            turn.status === 'error' ? 'error' : 'pending';

        // Build tab label - include attempt info if there were multiple attempts
        let tabLabel = `Turn ${turn.turn_number}`;
        if (turn.total_attempts && turn.total_attempts > 1) {
            tabLabel += ` <span class="attempt-badge">(Attempt ${turn.attempt_number}/${turn.total_attempts})</span>`;
        }

        // Create compound key for turn+attempt
        const turnKey = `${turn.turn_number}_${turn.attempt_number || 1}`;

        tab.className = `turn-tab ${statusClass} ${currentTurn === turnKey ? 'active' : ''}`;
        tab.innerHTML = `<span class="turn-status-icon">${statusIcon}</span> ${tabLabel}`;
        tab.title = turn.question ? turn.question.substring(0, 100) : `Turn ${turn.turn_number}`;
        tab.dataset.turnKey = turnKey;
        tab.onclick = () => {
            setCurrentTurn(turnKey);
            updateTurnTabs();
        };
        tabs.appendChild(tab);
    }

    nav.appendChild(tabs);

    // Add conversation history button - use unique turn count
    const historyBtn = document.createElement('button');
    historyBtn.id = 'conversation-history-btn';
    historyBtn.className = 'conversation-history-btn';
    historyBtn.innerHTML = `<span class="history-icon">💬</span> ${uniqueTurns} turn${uniqueTurns > 1 ? 's' : ''}`;
    historyBtn.onclick = () => toggleConversationHistory();
    nav.appendChild(historyBtn);

    headerEl.appendChild(nav);

    // Create conversation history panel (hidden by default)
    createConversationHistoryPanel(data);
}

/**
 * Create the conversation history floating panel
 */
function createConversationHistoryPanel(data) {
    // Remove existing panel if any
    const existing = document.getElementById('conversation-history-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'conversation-history-panel';
    panel.className = 'conversation-history-panel hidden';

    // Header
    const header = document.createElement('div');
    header.className = 'history-panel-header';
    header.innerHTML = `
        <span>Conversation History</span>
        <button class="history-close-btn" onclick="toggleConversationHistory()">✕</button>
    `;
    panel.appendChild(header);

    // Messages container
    const messages = document.createElement('div');
    messages.className = 'history-messages';

    // Build conversation from turns - only show unique turns (not each attempt)
    // For each turn number, use the LAST (successful) attempt
    const uniqueTurns = new Map();
    for (const turn of data.turns) {
        // Keep the last attempt for each turn number (overwrites earlier attempts)
        uniqueTurns.set(turn.turn_number, turn);
    }

    for (const turn of uniqueTurns.values()) {
        // User message (the question/prompt)
        const userMsg = document.createElement('div');
        userMsg.className = 'history-message user-message';
        userMsg.innerHTML = `
            <div class="message-header">
                <span class="message-role user-role">👤 You</span>
                <span class="message-turn">Turn ${turn.turn_number}</span>
            </div>
            <div class="message-content">${escapeHtml(turn.question || 'No question')}</div>
        `;
        messages.appendChild(userMsg);

        // Assistant message (the final answer for this turn - from the last attempt)
        const turnKey = `${turn.turn_number}_${turn.attempt_number || 1}`;
        const turnAnswers = Object.values(data.answers || {}).filter(a =>
            a.turnKey === turnKey && a.type === 'final_answer'
        );
        console.log('[ConvHistory] Turn', turn.turn_number, 'attempt', turn.attempt_number, 'turnAnswers count:', turnAnswers.length);
        const finalAnswer = turnAnswers[0]?.content || findFinalAnswerForTurn(data, turn.turn_number);
        console.log('[ConvHistory] Turn', turn.turn_number, 'finalAnswer length:', finalAnswer?.length);

        const assistantMsg = document.createElement('div');
        assistantMsg.className = 'history-message assistant-message';

        const needsTruncation = finalAnswer && finalAnswer.length > 500;
        const contentPreview = finalAnswer
            ? (needsTruncation ? finalAnswer.substring(0, 500) + '...' : finalAnswer)
            : 'No response recorded';

        // If truncation needed, show preview first; otherwise just show content
        if (needsTruncation) {
            assistantMsg.innerHTML = `
                <div class="message-header">
                    <span class="message-role assistant-role">🤖 MassGen</span>
                    <span class="message-turn">Turn ${turn.turn_number}</span>
                    <span class="message-winner">${turn.winner ? `Winner: ${turn.winner}` : ''}</span>
                </div>
                <div class="message-content message-preview">${escapeHtml(contentPreview)}</div>
                <div class="message-content message-full hidden">${escapeHtml(finalAnswer)}</div>
                <button class="show-more-btn" onclick="expandHistoryMessage(this)">▼ Show more</button>
            `;
        } else {
            assistantMsg.innerHTML = `
                <div class="message-header">
                    <span class="message-role assistant-role">🤖 MassGen</span>
                    <span class="message-turn">Turn ${turn.turn_number}</span>
                    <span class="message-winner">${turn.winner ? `Winner: ${turn.winner}` : ''}</span>
                </div>
                <div class="message-content">${escapeHtml(contentPreview)}</div>
            `;
        }
        messages.appendChild(assistantMsg);
    }

    panel.appendChild(messages);
    document.body.appendChild(panel);
}

/**
 * Find final answer for a specific turn from files
 */
function findFinalAnswerForTurn(data, turnNumber) {
    const files = data.files || {};
    for (const [path, content] of Object.entries(files)) {
        const pathTurn = extractTurnFromPath(path);
        if (pathTurn === turnNumber &&
            (path.includes('final/') || path.includes('__final__')) &&
            (path.endsWith('/answer.txt') || path.endsWith('__answer.txt'))) {
            return content;
        }
    }
    return null;
}

/**
 * Toggle conversation history panel visibility
 */
function toggleConversationHistory() {
    const panel = document.getElementById('conversation-history-panel');
    if (panel) {
        panel.classList.toggle('hidden');
    }
}

/**
 * Expand a history message to show full content
 */
function expandHistoryMessage(btn) {
    const container = btn.parentElement;
    const preview = container.querySelector('.message-preview');
    const fullContent = container.querySelector('.message-full');

    if (fullContent && preview) {
        const isExpanded = !fullContent.classList.contains('hidden');
        if (isExpanded) {
            // Collapse: show preview, hide full
            fullContent.classList.add('hidden');
            preview.classList.remove('hidden');
            btn.textContent = '▼ Show more';
        } else {
            // Expand: hide preview, show full
            preview.classList.add('hidden');
            fullContent.classList.remove('hidden');
            btn.textContent = '▲ Show less';
        }
    }
}

/**
 * Update turn tab active states and header metadata
 */
function updateTurnTabs() {
    const tabs = document.querySelectorAll('.turn-tab');
    tabs.forEach(tab => {
        // Each tab has data-turn-key attribute with compound key like "1_1"
        const tabKey = tab.dataset.turnKey;
        tab.classList.toggle('active', currentTurn === tabKey);
    });

    // Update header to show current turn's metadata
    // currentTurn is now a compound key like "1_1" (turn_attempt)
    if (sessionData && sessionData.turns && currentTurn !== null) {
        // Parse turn and attempt from compound key
        const [turnNum, attemptNum] = currentTurn.split('_').map(Number);
        const currentTurnData = sessionData.turns.find(t =>
            t.turn_number === turnNum && (t.attempt_number || 1) === attemptNum
        );
        if (currentTurnData) {
            // Update question
            const questionEl = document.getElementById('question');
            if (questionEl && currentTurnData.question) {
                questionEl.textContent = currentTurnData.question;
            }

            // Update winner
            const winnerEl = document.getElementById('winner');
            if (winnerEl) {
                winnerEl.textContent = currentTurnData.winner || 'N/A';
            }
        }

        // Update date, duration, cost from per-turn data
        const turnData = sessionData.perTurnData?.[currentTurn];
        if (turnData) {
            const statusMeta = turnData.status?.meta || {};
            const metricsTotals = turnData.metrics?.totals || {};

            // Date from turn's start time
            const dateEl = document.getElementById('date');
            if (dateEl && statusMeta.start_time) {
                dateEl.textContent = new Date(statusMeta.start_time * 1000).toLocaleString();
            }

            // Duration from turn's elapsed time
            const durationEl = document.getElementById('duration');
            if (durationEl && statusMeta.elapsed_seconds) {
                durationEl.textContent = formatDuration(statusMeta.elapsed_seconds);
            }

            // Cost from turn's metrics
            const costEl = document.getElementById('cost');
            if (costEl) {
                const cost = metricsTotals.estimated_cost || 0;
                costEl.textContent = `$${cost.toFixed(4)}`;
            }
        }
    }
}

/**
 * Check if any agent uses claude_code backend (tool metrics not tracked for this backend)
 */
function hasClaudeCodeBackend(data) {
    // Check parsed config agents
    const configAgents = data.executionMetadata?.config?.agents;
    if (Array.isArray(configAgents)) {
        for (const agent of configAgents) {
            if (agent.backend?.type === 'claude_code') {
                return true;
            }
        }
    }
    // Also check raw YAML in case parsing didn't work
    const rawYaml = data.executionMetadata?._raw;
    if (rawYaml && rawYaml.includes('type: claude_code')) {
        return true;
    }
    return false;
}

/**
 * Render stats grid
 */
function renderStats(data) {
    // Use turn-filtered data for stats
    const filteredData = getDataForCurrentTurn(data);
    const metrics = filteredData.metrics || {};
    const totals = metrics.totals || {};

    // If filtering by turn, use turn-specific totals; otherwise session totals
    const cost = currentTurn !== null ? (totals.estimated_cost || 0) : data.session.cost;
    const inputTokens = currentTurn !== null ? (totals.input_tokens || 0) : data.session.inputTokens;
    const outputTokens = currentTurn !== null ? (totals.output_tokens || 0) : data.session.outputTokens;
    const reasoningTokens = currentTurn !== null ? (totals.reasoning_tokens || 0) : data.session.reasoningTokens;
    const totalTokens = inputTokens + outputTokens + reasoningTokens;
    const totalRounds = currentTurn !== null ? (metrics.rounds?.total_rounds || 0) : data.session.totalRounds;
    const totalToolCalls = currentTurn !== null ? (metrics.tools?.total_calls || 0) : data.session.totalToolCalls;

    document.getElementById('stat-cost').textContent = `$${cost.toFixed(4)}`;
    document.getElementById('stat-tokens').textContent = formatNumber(totalTokens);

    // For claude_code backend, tool calls aren't tracked - show asterisk
    const toolsEl = document.getElementById('stat-tools');
    const usesClaudeCode = hasClaudeCodeBackend(data);
    if (usesClaudeCode && totalToolCalls === 0) {
        toolsEl.textContent = '0*';
        toolsEl.title = 'Tool calls are not tracked for claude_code backend agents';
    } else {
        toolsEl.textContent = totalToolCalls;
        toolsEl.title = '';
    }

    document.getElementById('stat-rounds').textContent = totalRounds;
    document.getElementById('stat-agents').textContent = data.session.numAgents;
}

/**
 * Render agent cards
 */
function renderAgents(data) {
    const container = document.getElementById('agents-container');
    // Use turn-filtered data
    const filteredData = getDataForCurrentTurn(data);
    const agents = filteredData.metrics.agents || {};
    const statusAgents = filteredData.status.agents || {};
    const winner = data.session.winner;

    // Also try to get agent list from execution metadata config
    let configAgents = [];
    if (data.executionMetadata?.config?.agents) {
        const cfgAgents = data.executionMetadata.config.agents;
        configAgents = Array.isArray(cfgAgents) ? cfgAgents : Object.values(cfgAgents);
    }

    // Fallback: try to extract agents from raw YAML if parsing didn't work
    if (configAgents.length === 0 && data.executionMetadata?._raw) {
        const rawYaml = data.executionMetadata._raw;
        // Look for patterns like "- id: agent_a" followed by "model: xxx"
        const agentMatches = rawYaml.matchAll(/- id: (\S+)[\s\S]*?model: (\S+)/g);
        for (const match of agentMatches) {
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

    // Collect all agent IDs from various sources
    const allAgentIds = new Set([
        ...Object.keys(agents),
        ...Object.keys(statusAgents),
        ...configAgents.map(a => a?.id).filter(Boolean),
        ...coordAgentIds
    ]);

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
    // Use turn-filtered data for tools
    const filteredData = getDataForCurrentTurn(data);
    const tools = filteredData.metrics.tools?.by_tool || {};

    if (Object.keys(tools).length === 0) {
        // Show informative message if using claude_code backend
        if (hasClaudeCodeBackend(data)) {
            container.innerHTML = '<div class="no-data">Tool metrics are not tracked for claude_code backend agents.<br><span style="font-size: 0.85em; opacity: 0.7;">Claude Code runs as a subprocess and handles its own tool execution.</span></div>';
        } else {
            container.innerHTML = '<div class="no-data">No tool data available</div>';
        }
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
    // Use turn-filtered data
    const filteredData = getDataForCurrentTurn(data);
    const events = filteredData.coordination.events || [];
    console.log('[renderTimeline] currentTurn:', currentTurn, 'events count:', events.length);

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
 * Render inline workspace files within an answer - split pane layout
 */
function renderInlineWorkspace(agentId, timestamp, workspaceFiles) {
    const fileEntries = Object.entries(workspaceFiles).sort();
    if (fileEntries.length === 0) return '';

    const workspaceId = `ws_${agentId}_${timestamp}`.replace(/[^a-zA-Z0-9]/g, '_');

    // Build file tree (left pane)
    let fileTreeHtml = '';
    for (const [filePath, content] of fileEntries) {
        const fileExt = filePath.split('.').pop().toLowerCase();
        const fileId = `${agentId}__${timestamp}__${filePath}`.replace(/[^a-zA-Z0-9]/g, '_');

        // Check if this is a binary/base64 file
        const isBinaryFile = ['pdf', 'pptx', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileExt);
        // For binary files, calculate size from base64 (base64 is ~4/3 of original size)
        const estimatedSize = isBinaryFile ? Math.floor(content.length * 0.75) : content.length;
        const sizeStr = estimatedSize > 1024
            ? `${(estimatedSize / 1024).toFixed(1)} KB`
            : `${estimatedSize} B`;

        const isPreviewable = window.canPreviewArtifact ? window.canPreviewArtifact(filePath, content) : false;

        const fileName = filePath.split('/').pop();
        fileTreeHtml += `
            <div class="ws-tree-file" data-file-id="${fileId}" data-workspace-id="${workspaceId}" onclick="selectWorkspaceFile('${workspaceId}', '${fileId}')" title="${escapeHtml(fileName)}">
                <span class="ws-tree-icon">${getFileIcon(fileExt)}</span>
                <span class="ws-tree-name">${escapeHtml(fileName)}</span>
                <span class="ws-tree-size">${sizeStr}</span>
            </div>
        `;
    }

    // Build preview pane data (stored in JS, rendered on selection)
    const previewDataScript = `
        <script type="application/json" id="ws-data-${workspaceId}">
            ${JSON.stringify(Object.fromEntries(fileEntries.map(([path, content]) => {
                const ext = path.split('.').pop().toLowerCase();
                const isBinary = ['pdf', 'pptx', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
                const pdfPath = path + '.pdf';
                const hasPdfVersion = isOfficeDocument(path) && workspaceFiles[pdfPath];
                return [
                    `${agentId}__${timestamp}__${path}`.replace(/[^a-zA-Z0-9]/g, '_'),
                    { path, content, ext, isBinary, hasPdfVersion, pdfPath: hasPdfVersion ? pdfPath : null }
                ];
            })))}
        </script>
    `;

    // Get first file for initial preview
    const firstFileId = fileEntries.length > 0
        ? `${agentId}__${timestamp}__${fileEntries[0][0]}`.replace(/[^a-zA-Z0-9]/g, '_')
        : null;

    const html = `
        <div class="inline-workspace split-pane" id="${workspaceId}">
            <div class="inline-workspace-header">
                <span class="inline-ws-icon">📁</span>
                <span class="inline-ws-title">Workspace Files (${fileEntries.length})</span>
            </div>
            <div class="ws-split-container">
                <div class="ws-file-tree">
                    ${fileTreeHtml}
                </div>
                <div class="ws-preview-pane" id="preview-${workspaceId}">
                    <div class="ws-preview-placeholder">
                        <span>👈 Select a file to preview</span>
                    </div>
                </div>
            </div>
            ${previewDataScript}
        </div>
    `;

    // Auto-select first file after render
    if (firstFileId) {
        setTimeout(() => selectWorkspaceFile(workspaceId, firstFileId), 0);
    }

    return html;
}

/**
 * Select and preview a file in the split-pane workspace
 */
function selectWorkspaceFile(workspaceId, fileId) {
    const workspace = document.getElementById(workspaceId);
    if (!workspace) return;

    // Update selected state in file tree
    workspace.querySelectorAll('.ws-tree-file').forEach(f => f.classList.remove('selected'));
    const selectedFile = workspace.querySelector(`.ws-tree-file[data-file-id="${fileId}"]`);
    if (selectedFile) selectedFile.classList.add('selected');

    // Get file data from embedded JSON
    const dataScript = document.getElementById(`ws-data-${workspaceId}`);
    if (!dataScript) return;

    let filesData;
    try {
        filesData = JSON.parse(dataScript.textContent);
    } catch (e) {
        console.error('Failed to parse workspace data:', e);
        return;
    }

    const fileData = filesData[fileId];
    if (!fileData) return;

    const previewPane = document.getElementById(`preview-${workspaceId}`);
    if (!previewPane) return;

    // Build preview content
    const { path, content, ext, isBinary, hasPdfVersion, pdfPath } = fileData;
    const isPdf = ext === 'pdf';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const isPreviewable = window.canPreviewArtifact ? window.canPreviewArtifact(path, content) : false;

    // Action buttons
    const previewButton = isPreviewable
        ? `<button class="ws-action-btn preview-btn" onclick="event.stopPropagation(); openArtifactPreviewFromElement(this)" data-filename="${escapeHtml(path)}" data-fileid="${fileId}" data-has-pdf="${hasPdfVersion}" data-pdf-path="${hasPdfVersion ? escapeHtml(pdfPath) : ''}">👁️ Preview</button>`
        : '';

    let contentHtml;
    if (isPdf) {
        contentHtml = `
            <div class="ws-preview-content pdf">
                <iframe src="data:application/pdf;base64,${content}" style="width:100%; height:100%; border:none;"></iframe>
            </div>
        `;
    } else if (isImage) {
        const mimeType = ext === 'png' ? 'image/png' :
                       ext === 'gif' ? 'image/gif' :
                       ext === 'webp' ? 'image/webp' : 'image/jpeg';
        contentHtml = `
            <div class="ws-preview-content image">
                <img src="data:${mimeType};base64,${content}" />
            </div>
        `;
    } else if (isBinary) {
        contentHtml = `
            <div class="ws-preview-content binary">
                <div class="ws-binary-notice">
                    <span class="ws-binary-icon">📄</span>
                    <p>Binary file (${ext.toUpperCase()})</p>
                    <p class="ws-binary-hint">${hasPdfVersion ? 'PDF preview available' : 'Use Download to save'}</p>
                </div>
            </div>
        `;
    } else {
        // Text/code files
        contentHtml = `
            <div class="ws-preview-content code">
                <pre><code>${escapeHtml(content)}</code></pre>
            </div>
        `;
    }

    previewPane.innerHTML = `
        <div class="ws-preview-header">
            <span class="ws-preview-filename">${escapeHtml(path)}</span>
            <div class="ws-preview-actions">
                ${previewButton}
                ${!isBinary ? `<button class="ws-action-btn" onclick="copyToClipboard(\`${escapeHtml(content).replace(/`/g, '\\`')}\`)">📋 Copy</button>` : ''}
                <button class="ws-action-btn" onclick="downloadWorkspaceFileInline('${fileId}', '${escapeHtml(path)}')">⬇️ Download</button>
            </div>
        </div>
        ${contentHtml}
    `;
}

/**
 * Render answers and votes - tabbed by agent, then sub-tabs for answers/votes
 */
function renderAnswers(data) {
    const container = document.getElementById('answers-container');
    // Use turn-filtered data
    const filteredData = getDataForCurrentTurn(data);
    const answers = filteredData.answers;
    // Filter votes by current turn (extract turn number from compound key)
    const allVotes = data.votes;
    const votes = {};
    const currentTurnNum = currentTurn ? parseInt(currentTurn.split('_')[0], 10) : null;
    for (const [agentId, agentVotes] of Object.entries(allVotes)) {
        const filteredVotes = agentVotes.filter(v =>
            currentTurnNum === null || v.turn === null || v.turn === currentTurnNum
        );
        if (filteredVotes.length > 0) {
            votes[agentId] = filteredVotes;
        }
    }
    const winner = data.session.winner;
    // Use turn-filtered workspace files
    const workspaceFiles = filteredData.workspaceFiles || {};
    const statusAgents = filteredData.status?.agents || {};

    // Filter out final answers - they're shown in the Final Answer section
    const intermediateAnswers = Object.entries(answers)
        .filter(([label, answer]) => answer.type !== 'final_answer')
        .sort((a, b) => a[0].localeCompare(b[0]));

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

    // Get all agent IDs - include agents with errors but no answers
    const allAgentIds = new Set(Object.keys(answersByAgent));
    Object.keys(statusAgents).forEach(id => allAgentIds.add(id));
    const agentIds = Array.from(allAgentIds).sort();

    // Get error info for each agent
    const agentErrors = {};
    for (const [agentId, agentStatus] of Object.entries(statusAgents)) {
        if (agentStatus.error) {
            agentErrors[agentId] = agentStatus.error;
        } else if (agentStatus.status === 'error') {
            agentErrors[agentId] = { type: 'error', message: 'Agent encountered an error' };
        }
    }

    if (agentIds.length === 0) {
        container.innerHTML = '<div class="no-data">No agent activity recorded</div>';
        return;
    }

    // Build agent tabs
    let html = '<div class="agent-tabs">';
    agentIds.forEach((agentId, index) => {
        const isWinner = agentId === winner;
        const isFirst = index === 0;
        const hasError = !!agentErrors[agentId];
        const answerCount = answersByAgent[agentId]?.length || 0;
        html += `
            <div class="agent-tab ${isFirst ? 'active' : ''} ${isWinner ? 'winner-tab' : ''} ${hasError ? 'error-tab' : ''}" data-agent="${escapeHtml(agentId)}">
                ${escapeHtml(agentId)}
                ${isWinner ? '<span class="winner-dot"></span>' : ''}
                ${hasError && !isWinner ? '<span class="error-dot" title="Agent error">!</span>' : ''}
                <span class="tab-count">${answerCount}</span>
            </div>
        `;
    });
    html += '</div>';

    // Build content panels for each agent
    html += '<div class="agent-panels">';
    agentIds.forEach((agentId, agentIndex) => {
        const agentAnswers = answersByAgent[agentId] || [];
        const agentVotes = votes[agentId] || []; // Array of votes
        const agentWorkspaceByTimestamp = workspaceFiles[agentId] || {}; // { timestamp: { filePath: content } }
        const isFirst = agentIndex === 0;
        const agentError = agentErrors[agentId];

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

        // Show error banner if agent has error and no answers
        if (agentError && agentAnswers.length === 0) {
            html += `
                <div class="agent-error-banner">
                    <span class="error-icon">⚠️</span>
                    <div class="error-details">
                        <div class="error-type">${escapeHtml(agentError.type || 'Error')}</div>
                        <div class="error-message">${escapeHtml(agentError.message || 'Agent encountered an error')}</div>
                    </div>
                </div>
            `;
        }

        agentAnswers.forEach(({ label, answer }, idx) => {
            const answerNum = idx + 1;
            const shortLabel = `${agentNum}.${answerNum}`;

            // Get workspace files for this specific answer (by timestamp)
            // For final answers (which have __final__ instead of a timestamp), use 'final' as the key
            const isFinalAnswer = label.includes('/final/') || label.includes('__final__');
            let answerTimestamp = answer.timestamp;
            if (!answerTimestamp) {
                if (isFinalAnswer) {
                    answerTimestamp = 'final';
                } else {
                    // Try to extract timestamp from label
                    // Label might be like: turn_1__attempt_1__agent_a__20251231_065145__answer.txt
                    const parts = label.split('__');
                    for (const part of parts) {
                        if (part.match(/^\d{8}_\d+/)) {
                            answerTimestamp = part;
                            break;
                        }
                    }
                }
            }
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
 * Render final answer with workspace files
 */
function renderFinalAnswer(data) {
    const container = document.getElementById('final-answer');

    // Use turn-filtered files and data
    const filteredFiles = filterFilesByTurn(data.files);
    const filteredData = getDataForCurrentTurn(data);
    const workspaceFiles = filteredData.workspaceFiles || {};

    // Try to find final answer in files
    let finalAnswer = '';
    let finalAgentId = null;
    for (const [path, content] of Object.entries(filteredFiles)) {
        if ((path.includes('final/') || path.includes('__final__')) && (path.endsWith('/answer.txt') || path.endsWith('__answer.txt'))) {
            finalAnswer = content;
            // Extract agent ID from path
            const { agentId } = extractAgentFromPath(path);
            finalAgentId = agentId;
            break;
        }
    }

    if (!finalAnswer) {
        // Try coordination table
        finalAnswer = data.files['coordination_table.txt'] || '';
    }

    // Build HTML with answer text
    let html = `<div class="final-answer-text">${escapeHtml(finalAnswer || 'No final answer available')}</div>`;

    // Add workspace files for the final answer if available
    if (finalAgentId && workspaceFiles[finalAgentId]) {
        const agentWorkspace = workspaceFiles[finalAgentId];
        // Try 'final' key first, then fall back to the latest timestamp
        let finalWorkspace = agentWorkspace['final'] || {};
        let workspaceKey = 'final';

        // If no 'final' key, get the latest timestamp's workspace
        if (Object.keys(finalWorkspace).length === 0) {
            const timestamps = Object.keys(agentWorkspace).filter(k => k !== 'default' && k !== 'final');
            if (timestamps.length > 0) {
                // Sort timestamps descending to get the latest
                timestamps.sort((a, b) => b.localeCompare(a));
                workspaceKey = timestamps[0];
                finalWorkspace = agentWorkspace[workspaceKey] || {};
            }
        }

        const fileCount = Object.keys(finalWorkspace).length;
        if (fileCount > 0) {
            html += renderInlineWorkspace(finalAgentId, workspaceKey, finalWorkspace);
        }
    }

    container.innerHTML = html;
}

/**
 * Render agent outputs
 */
function renderOutputs(data) {
    const container = document.getElementById('outputs-container');

    // Filter agent outputs by current turn
    const outputs = {};
    for (const [path, content] of Object.entries(data.files || {})) {
        // Handle both formats: turn_X/attempt_Y/agent_outputs/agent.txt and turn_X__attempt_Y__agent_outputs__agent.txt
        const isAgentOutput = path.includes('agent_outputs/') || path.includes('__agent_outputs__');
        const isTextFile = path.endsWith('.txt');

        if (isAgentOutput && isTextFile) {
            // Use compound key for filtering (turn_attempt, e.g., "1_2")
            const turnAttempt = extractTurnAttemptFromPath(path);
            const fileKey = turnAttempt?.key || null;
            // Filter by current turn+attempt if set
            if (currentTurn !== null && fileKey !== null && fileKey !== currentTurn) {
                continue;
            }

            // Extract agent name from path
            let filename;
            if (path.includes('__agent_outputs__')) {
                // Flattened: turn_1__attempt_1__agent_outputs__agent_a.txt
                const parts = path.split('__');
                filename = parts[parts.length - 1].replace('.txt', '');
            } else {
                // Nested: turn_1/attempt_1/agent_outputs/agent_a.txt
                const parts = path.split('/');
                filename = parts[parts.length - 1].replace('.txt', '');
            }

            // Skip system_status and _latest files
            if (filename !== 'system_status' && !filename.endsWith('_latest')) {
                outputs[filename] = content;
            }
        }
    }

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
    let agents = config.config?.agents || [];
    if (!Array.isArray(agents)) {
        // Convert object to array if needed
        agents = Object.values(agents);
    }

    // Fallback: extract agents from raw YAML if parsing didn't work
    if (agents.length === 0 && config._raw) {
        const rawYaml = config._raw;
        const agentMatches = [...rawYaml.matchAll(/- id: (\S+)[\s\S]*?model: (\S+)/g)];
        for (const match of agentMatches) {
            agents.push({
                id: match[1],
                backend: { model: match[2] }
            });
        }
    }

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
 * Build a directory tree from flat file paths
 * Returns: { name: string, path: string, children: Map, files: Map }
 */
function buildDirectoryTree(files) {
    const root = { name: '', path: '', children: new Map(), files: new Map() };

    for (const [filePath, content] of Object.entries(files)) {
        const parts = filePath.split('/');
        let current = root;

        // Navigate/create directory structure
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            const dirPath = parts.slice(0, i + 1).join('/');
            if (!current.children.has(dirName)) {
                current.children.set(dirName, {
                    name: dirName,
                    path: dirPath,
                    children: new Map(),
                    files: new Map()
                });
            }
            current = current.children.get(dirName);
        }

        // Add file to current directory
        const fileName = parts[parts.length - 1];
        current.files.set(fileName, { path: filePath, content });
    }

    return root;
}

/**
 * Render a directory tree node recursively
 */
function renderTreeNode(node, agentId, depth = 0) {
    let html = '';
    const indent = depth * 16; // 16px per level

    // Render subdirectories first (sorted)
    const sortedDirs = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [dirName, dirNode] of sortedDirs) {
        const folderId = `folder-${agentId}__${dirNode.path}`.replace(/[^a-zA-Z0-9]/g, '_');
        const fileCount = countFilesInTree(dirNode);

        html += `
            <div class="tree-folder" id="${folderId}" style="padding-left: ${indent}px">
                <div class="tree-folder-header" onclick="toggleTreeFolder('${folderId}')">
                    <span class="tree-folder-icon">📁</span>
                    <span class="tree-folder-name">${escapeHtml(dirName)}/</span>
                    <span class="tree-folder-count">${fileCount}</span>
                    <span class="tree-folder-toggle">▶</span>
                </div>
                <div class="tree-folder-content">
                    ${renderTreeNode(dirNode, agentId, depth + 1)}
                </div>
            </div>
        `;
    }

    // Render files in this directory (sorted)
    const sortedFiles = Array.from(node.files.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [fileName, fileData] of sortedFiles) {
        const fileExt = fileName.split('.').pop().toLowerCase();
        const langClass = ['py', 'js', 'ts', 'json', 'yaml', 'yml', 'sh', 'html', 'css', 'md', 'txt'].includes(fileExt)
            ? `language-${fileExt}` : '';
        const fileId = `${agentId}__${fileData.path}`.replace(/[^a-zA-Z0-9]/g, '_');
        const sizeStr = fileData.content.length > 1024
            ? `${(fileData.content.length / 1024).toFixed(1)} KB`
            : `${fileData.content.length} B`;

        // Check if file can be previewed using React renderers
        const isPreviewable = window.canPreviewArtifact ? window.canPreviewArtifact(fileName, fileData.content) : false;
        const previewBadge = isPreviewable ? '<span class="preview-badge">Preview</span>' : '';
        // Use smart preview for Office documents (will use PDF version if available)
        const previewButton = isPreviewable
            ? `<button class="tree-file-preview" onclick="event.stopPropagation(); openSmartArtifactPreview(sessionData.workspaceFiles['${escapeHtml(agentId)}']['${escapeHtml(fileData.path)}'], '${escapeHtml(fileName)}', '${escapeHtml(agentId)}', '${escapeHtml(fileData.path)}')">Preview</button>`
            : '';

        html += `
            <div class="tree-file" id="file-${fileId}" style="padding-left: ${indent}px">
                <div class="tree-file-header" onclick="toggleWorkspaceFile('${fileId}')">
                    <span class="tree-file-icon">${getFileIcon(fileExt)}</span>
                    <span class="tree-file-name">${escapeHtml(fileName)}${previewBadge}</span>
                    <span class="tree-file-size">${sizeStr}</span>
                    <span class="tree-file-toggle">▶</span>
                </div>
                <div class="tree-file-content">
                    <div class="workspace-file-actions">
                        ${previewButton}
                        <button class="ws-action-btn" onclick="copyWorkspaceFile('${escapeHtml(agentId)}', '${escapeHtml(fileData.path)}')">
                            📋 Copy
                        </button>
                        <button class="ws-action-btn" onclick="downloadWorkspaceFile('${escapeHtml(agentId)}', '${escapeHtml(fileData.path)}')">
                            ⬇️ Download
                        </button>
                    </div>
                    <div class="workspace-file-code">
                        <pre class="${langClass}">${escapeHtml(fileData.content)}</pre>
                    </div>
                </div>
            </div>
        `;
    }

    return html;
}

/**
 * Count total files in a tree node (recursive)
 */
function countFilesInTree(node) {
    let count = node.files.size;
    for (const child of node.children.values()) {
        count += countFilesInTree(child);
    }
    return count;
}

/**
 * Toggle tree folder expansion
 */
window.toggleTreeFolder = function(folderId) {
    const folderEl = document.getElementById(folderId);
    if (folderEl) {
        folderEl.classList.toggle('expanded');
    }
};

/**
 * Flatten workspace files from nested timestamp structure to flat file map
 * Input: { timestamp: { filePath: content } }
 * Output: { filePath: content }
 */
function flattenWorkspaceFiles(agentFiles) {
    const flat = {};
    for (const [timestamp, files] of Object.entries(agentFiles)) {
        if (typeof files === 'object') {
            for (const [path, content] of Object.entries(files)) {
                // Prefix with timestamp if multiple timestamps exist
                flat[path] = content;
            }
        }
    }
    return flat;
}

/**
 * Render workspace browser with copy/download functionality and directory tree
 */
function renderWorkspace(data) {
    const container = document.getElementById('workspace-container');
    if (!container) return;

    // Use turn-filtered data for workspace files
    const filteredData = getDataForCurrentTurn(data);
    const workspaceFiles = filteredData.workspaceFiles;

    if (!workspaceFiles || Object.keys(workspaceFiles).length === 0) {
        container.innerHTML = '<div class="no-data">No workspace files available</div>';
        return;
    }

    // Store files globally for copy/download (flatten nested structure)
    window._workspaceFiles = {};
    for (const [agentId, agentFiles] of Object.entries(workspaceFiles)) {
        window._workspaceFiles[agentId] = flattenWorkspaceFiles(agentFiles);
    }

    let html = '<div class="workspace-browser">';

    for (const [agentId, agentFiles] of Object.entries(workspaceFiles).sort()) {
        // Flatten the timestamp-keyed structure to a simple file map
        const flatFiles = flattenWorkspaceFiles(agentFiles);
        const fileCount = Object.keys(flatFiles).length;

        // Build directory tree from flat files
        const tree = buildDirectoryTree(flatFiles);

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
                    <div class="workspace-tree">
                        ${renderTreeNode(tree, agentId)}
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
        script.integrity = 'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==';
        script.crossOrigin = 'anonymous';
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

// =============================================================================
// Artifact Preview Functions (using React bundle from webui)
// =============================================================================

// Track the current artifact unmount function for cleanup
let currentArtifactUnmount = null;

/**
 * Open artifact preview modal using React renderers from webui bundle
 * @param {string} content - The file content (text or base64)
 * @param {string} fileName - The file name for type detection
 * @param {Object} relatedFiles - Optional related files for HTML (CSS, JS, etc.)
 */
window.openArtifactPreview = function(content, fileName, relatedFiles = {}) {
    const modal = document.getElementById('artifact-preview-modal');
    const container = document.getElementById('artifact-preview-container');
    const titleEl = document.getElementById('artifact-preview-title');

    if (!window.MassGenRenderers) {
        console.error('MassGen Renderers bundle not loaded');
        container.innerHTML = '<div class="error">Artifact preview not available - renderer bundle not loaded</div>';
        modal.classList.add('active');
        return;
    }

    const {
        detectArtifactType,
        HtmlPreview,
        ImagePreview,
        MarkdownPreview,
        SvgPreview,
        PdfPreview,
        MermaidPreview,
        VideoPreview,
        DocxPreview,
        XlsxPreview,
        PptxPreview,
        SandpackPreview,
        render,
        React
    } = window.MassGenRenderers;

    // Update title with file name
    titleEl.textContent = fileName || 'Artifact Preview';

    // Detect artifact type
    const artifactType = detectArtifactType(fileName, undefined, content);

    let component;
    switch (artifactType) {
        case 'html':
            component = React.createElement(HtmlPreview, { content, fileName, relatedFiles });
            break;
        case 'image':
            component = React.createElement(ImagePreview, { content, fileName });
            break;
        case 'markdown':
            component = React.createElement(MarkdownPreview, { content, fileName });
            break;
        case 'svg':
            component = React.createElement(SvgPreview, { content, fileName });
            break;
        case 'pdf':
            component = React.createElement(PdfPreview, { content, fileName });
            break;
        case 'mermaid':
            component = React.createElement(MermaidPreview, { content, fileName });
            break;
        case 'video':
            component = React.createElement(VideoPreview, { content, fileName });
            break;
        case 'docx':
            component = React.createElement(DocxPreview, { content, fileName });
            break;
        case 'xlsx':
            component = React.createElement(XlsxPreview, { content, fileName });
            break;
        case 'pptx':
            component = React.createElement(PptxPreview, { content, fileName });
            break;
        case 'react':
            component = React.createElement(SandpackPreview, { content, fileName });
            break;
        default:
            // Fallback to raw content display for unsupported types
            container.innerHTML = `<pre class="raw-content">${escapeHtml(content)}</pre>`;
            modal.classList.add('active');
            return;
    }

    // Render React component
    currentArtifactUnmount = render(container, component);
    modal.classList.add('active');
};

/**
 * Close artifact preview modal and cleanup React component
 */
window.closeArtifactPreview = function() {
    const modal = document.getElementById('artifact-preview-modal');
    const container = document.getElementById('artifact-preview-container');

    modal.classList.remove('active');

    // Cleanup React component
    if (currentArtifactUnmount) {
        currentArtifactUnmount();
        currentArtifactUnmount = null;
    }

    // Clear container
    container.innerHTML = '';
};

/**
 * Check if a file can be previewed using React renderers
 * @param {string} fileName - The file name
 * @param {string} content - Optional content for content-based detection
 * @returns {boolean}
 */
window.canPreviewArtifact = function(fileName, content) {
    if (!window.MassGenRenderers || typeof window.MassGenRenderers.canPreviewFile !== 'function') {
        return false;
    }
    return window.MassGenRenderers.canPreviewFile(fileName, undefined, content);
};

/**
 * Find PDF content for an Office document in workspace files
 * Looks for a corresponding .pdf file (e.g., report.docx -> report.docx.pdf)
 * @param {string} agentId - The agent ID
 * @param {string} filePath - The original file path
 * @returns {Object|null} {content, pdfPath} if found, null otherwise
 */
function findPdfVersionForOfficeDoc(agentId, filePath) {
    if (!sessionData || !sessionData.workspaceFiles) return null;

    const pdfPath = getPdfVersionPath(filePath);
    const agentFiles = sessionData.workspaceFiles[agentId];

    if (agentFiles && agentFiles[pdfPath]) {
        return { content: agentFiles[pdfPath], pdfPath };
    }

    return null;
}

/**
 * Smart preview: For Office documents, prefer the PDF version if available
 * @param {string} content - The file content
 * @param {string} fileName - The file name
 * @param {string} agentId - Optional agent ID for looking up PDF versions
 * @param {string} filePath - Optional file path for looking up PDF versions
 */
window.openSmartArtifactPreview = function(content, fileName, agentId, filePath) {
    // For Office documents, check if we have a pre-converted PDF version
    if (isOfficeDocument(fileName) && agentId && filePath) {
        const pdfVersion = findPdfVersionForOfficeDoc(agentId, filePath);
        if (pdfVersion) {
            // Use the PDF version for preview (better quality)
            openArtifactPreview(pdfVersion.content, fileName + '.pdf');
            return;
        }
    }

    // Fall back to regular preview
    openArtifactPreview(content, fileName);
};

/**
 * Open artifact preview from a button element (reads content from sibling pre element)
 * For Office documents, uses the PDF version if available for better quality
 * @param {HTMLElement} buttonEl - The preview button element
 */
window.openArtifactPreviewFromElement = function(buttonEl) {
    const fileName = buttonEl.dataset.filename;
    const fileId = buttonEl.dataset.fileid;
    const hasPdf = buttonEl.dataset.hasPdf === 'true';
    const pdfPath = buttonEl.dataset.pdfPath;

    // Find the file container and get content from the pre element
    const fileContainer = document.getElementById('file-' + fileId);
    if (!fileContainer) {
        console.error('Could not find file container:', fileId);
        return;
    }

    // For Office documents with PDF version, find and use the PDF content
    if (hasPdf && pdfPath) {
        // The PDF file should be in the same parent container (inline-workspace-files)
        const pdfFileId = fileId.replace(fileName.replace(/[^a-zA-Z0-9]/g, '_'), pdfPath.replace(/[^a-zA-Z0-9]/g, '_'));
        const pdfContainer = document.getElementById('file-' + pdfFileId);
        if (pdfContainer) {
            const pdfPreElement = pdfContainer.querySelector('.workspace-file-code pre');
            if (pdfPreElement) {
                openArtifactPreview(pdfPreElement.textContent, pdfPath);
                return;
            }
        }
        // If we can't find the PDF container, try looking in the same parent
        const parent = fileContainer.closest('.inline-workspace-files');
        if (parent) {
            const allFiles = parent.querySelectorAll('.workspace-file');
            for (const file of allFiles) {
                const header = file.querySelector('.workspace-file-path');
                if (header && header.textContent.includes(pdfPath)) {
                    const pdfPre = file.querySelector('.workspace-file-code pre');
                    if (pdfPre) {
                        openArtifactPreview(pdfPre.textContent, pdfPath);
                        return;
                    }
                }
            }
        }
    }

    // Fall back to original content
    const preElement = fileContainer.querySelector('.workspace-file-code pre');
    if (!preElement) {
        console.error('Could not find pre element in file container');
        return;
    }

    const content = preElement.textContent;
    openArtifactPreview(content, fileName);
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
