/**
 * MassGen Session Viewer
 * Fetches and displays MassGen session data from GitHub Gist
 */

// Global state
let sessionData = {};

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
 */
function parseGistFiles(gist) {
    const files = {};

    for (const [filename, fileData] of Object.entries(gist.files)) {
        const path = unflattenPath(filename);
        const content = fileData.content;

        // Try to parse JSON files
        if (filename.endsWith('.json')) {
            try {
                files[path] = JSON.parse(content);
            } catch {
                files[path] = content;
            }
        } else {
            files[path] = content;
        }
    }

    return files;
}

/**
 * Extract session data from parsed files
 */
function extractSessionData(files) {
    const metrics = files['metrics_summary.json'] || {};
    const status = files['status.json'] || {};
    const coordination = files['coordination_events.json'] || {};
    const snapshotMappings = files['snapshot_mappings.json'] || {};

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
        if (path.includes('/answer.txt')) {
            const parts = path.split('/');
            const agentId = parts[0];
            const timestamp = parts[1];
            const label = `${agentId}.${timestamp}`;
            answers[label] = {
                label,
                agent_id: agentId,
                content: content,
                type: path.includes('final/') ? 'final_answer' : 'answer'
            };
        }
    }

    // Extract votes from files
    const votes = {};
    for (const [path, content] of Object.entries(files)) {
        if (path.endsWith('/vote.json') && typeof content === 'object') {
            const parts = path.split('/');
            const agentId = parts[0];
            votes[agentId] = {
                agent_id: agentId,
                voted_for: content.voted_for,
                voted_for_label: content.voted_for_label,
                reason: content.reason
            };
        }
    }

    // Extract agent outputs
    const agentOutputs = {};
    for (const [path, content] of Object.entries(files)) {
        if (path.startsWith('agent_outputs/') && path.endsWith('.txt')) {
            const filename = path.replace('agent_outputs/', '').replace('.txt', '');
            if (filename !== 'system_status') {
                agentOutputs[filename] = content;
            }
        }
    }

    return {
        metrics,
        status,
        coordination,
        snapshotMappings,
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
            numAgents: meta.num_agents || Object.keys(metrics.agents || {}).length
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

    if (Object.keys(agents).length === 0 && Object.keys(statusAgents).length === 0) {
        container.innerHTML = '<div class="no-data">No agent data available</div>';
        return;
    }

    const allAgents = new Set([...Object.keys(agents), ...Object.keys(statusAgents)]);

    let html = '';
    for (const agentId of Array.from(allAgents).sort()) {
        const agentMetrics = agents[agentId] || {};
        const agentStatus = statusAgents[agentId] || {};
        const isWinner = agentId === winner;

        const tokenUsage = agentMetrics.token_usage || agentStatus.token_usage || {};
        const inputTokens = tokenUsage.input_tokens || 0;
        const outputTokens = tokenUsage.output_tokens || 0;
        const cost = tokenUsage.estimated_cost || 0;
        const status = agentStatus.status || 'unknown';
        const answerCount = agentStatus.answer_count || 0;

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
                <div class="agent-stats">
                    <div class="agent-stat">
                        <span class="agent-stat-label">Status</span>
                        <span class="agent-stat-value">${escapeHtml(status)}</span>
                    </div>
                    <div class="agent-stat">
                        <span class="agent-stat-label">Answers</span>
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
 * Render coordination timeline
 */
function renderTimeline(data) {
    const container = document.getElementById('timeline-container');
    const events = data.coordination.events || [];

    const keyEventTypes = new Set([
        'session_start', 'session_end', 'new_answer', 'vote_cast',
        'restart_triggered', 'restart_completed', 'final_agent_selected',
        'final_answer', 'error'
    ]);

    const filteredEvents = events
        .filter(e => keyEventTypes.has(e.event_type))
        .slice(0, 50);

    if (filteredEvents.length === 0) {
        container.innerHTML = '<div class="no-data">No timeline events available</div>';
        return;
    }

    const startTime = data.coordination.session_metadata?.start_time || filteredEvents[0]?.timestamp || 0;

    let html = '';
    for (const event of filteredEvents) {
        const eventType = event.event_type || 'unknown';
        const timestamp = event.timestamp || 0;
        const agentId = event.agent_id;
        const details = event.details || '';

        const relativeTime = timestamp - startTime;
        const timeStr = `+${relativeTime.toFixed(1)}s`;

        let eventClass = 'timeline-event';
        if (eventType.includes('answer')) eventClass += ' answer';
        else if (eventType.includes('vote')) eventClass += ' vote';
        else if (eventType.includes('restart')) eventClass += ' restart';
        else if (eventType.includes('error')) eventClass += ' error';
        else if (eventType.includes('final')) eventClass += ' final';

        const eventTypeDisplay = eventType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const agentHtml = agentId ? `<span class="event-agent">${escapeHtml(agentId)}</span>: ` : '';

        html += `
            <div class="${eventClass}">
                <div class="event-header">
                    <span class="event-type">${escapeHtml(eventTypeDisplay)}</span>
                    <span class="event-time">${timeStr}</span>
                </div>
                <div class="event-details">${agentHtml}${escapeHtml(details.substring(0, 200))}</div>
            </div>
        `;
    }

    container.innerHTML = html;
}

/**
 * Render answers and votes
 */
function renderAnswers(data) {
    const container = document.getElementById('answers-container');
    const answers = data.answers;
    const votes = data.votes;
    const winner = data.session.winner;

    if (Object.keys(answers).length === 0) {
        container.innerHTML = '<div class="no-data">No answers recorded</div>';
        return;
    }

    // Build tabs and content
    const sortedAnswers = Object.entries(answers).sort((a, b) => a[0].localeCompare(b[0]));

    let tabsHtml = '<div class="answer-tabs">';
    let contentHtml = '';

    sortedAnswers.forEach(([label, answer], index) => {
        const agentId = answer.agent_id;
        const isWinner = agentId === winner;
        const isFirst = index === 0;
        const answerType = answer.type || 'answer';

        let tabClass = 'answer-tab';
        if (isWinner) tabClass += ' winner-tab';
        if (isFirst) tabClass += ' active';

        const displayLabel = answerType === 'final_answer' ? `${label} (Final)` : label;
        const winnerIndicator = isWinner && answerType === 'final_answer' ? ' - Winner' : '';

        tabsHtml += `<div class="${tabClass}" data-target="answer-${index}">${escapeHtml(displayLabel)}${winnerIndicator}</div>`;

        // Get vote for this agent
        const agentVote = votes[agentId];
        let voteHtml = '';
        if (agentVote) {
            voteHtml = `
                <div class="vote-info">
                    <div class="vote-info-header">Vote: ${escapeHtml(String(agentVote.voted_for_label || agentVote.voted_for || ''))}</div>
                    <div class="vote-reason">${escapeHtml(String(agentVote.reason || '').substring(0, 1000))}</div>
                </div>
            `;
        }

        const contentClass = isFirst ? 'answer-content active' : 'answer-content';
        contentHtml += `
            <div class="${contentClass}" id="answer-${index}">
                <div class="answer-meta">
                    <div class="answer-meta-item">Agent: <span>${escapeHtml(String(agentId))}</span></div>
                    <div class="answer-meta-item">Label: <span>${escapeHtml(label)}</span></div>
                    <div class="answer-meta-item">Type: <span>${escapeHtml(answerType)}</span></div>
                </div>
                <div class="answer-text">${escapeHtml(answer.content || 'No content available')}</div>
                ${voteHtml}
            </div>
        `;
    });

    tabsHtml += '</div>';

    container.innerHTML = tabsHtml + contentHtml;

    // Add tab click handlers
    container.querySelectorAll('.answer-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-target');

            container.querySelectorAll('.answer-tab').forEach(t => t.classList.remove('active'));
            container.querySelectorAll('.answer-content').forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const target = document.getElementById(targetId);
            if (target) target.classList.add('active');
        });
    });
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

    // Look for execution metadata
    let config = null;
    for (const [path, content] of Object.entries(data.files)) {
        if (path.includes('execution_metadata') && typeof content === 'object') {
            config = content;
            break;
        }
    }

    if (!config) {
        container.innerHTML = '<div class="no-data">No configuration data available</div>';
        return;
    }

    container.innerHTML = `
        <div class="collapsible">
            <div class="collapsible-header">
                <span>Execution Configuration</span>
                <span class="collapsible-icon">&#x25BC;</span>
            </div>
            <div class="collapsible-content">
                <div class="config-block">${escapeHtml(JSON.stringify(config, null, 2))}</div>
            </div>
        </div>
    `;

    container.querySelector('.collapsible-header').addEventListener('click', function() {
        this.parentElement.classList.toggle('open');
    });
}

/**
 * Render gist link
 */
function renderGistLink(gistId) {
    const container = document.getElementById('gist-link');
    container.innerHTML = `<a href="https://gist.github.com/${gistId}" target="_blank">View raw data on GitHub Gist</a>`;
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
        const files = parseGistFiles(gist);
        sessionData = extractSessionData(files);

        // Render all sections
        renderHeader(sessionData);
        renderStats(sessionData);
        renderAgents(sessionData);
        renderTools(sessionData);
        renderTimeline(sessionData);
        renderAnswers(sessionData);
        renderFinalAnswer(sessionData);
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
