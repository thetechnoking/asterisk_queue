const redisClient = require('../lib/redisClient');

// Helper functions for Redis keys
const getQueueKey = (callCenterId, queueId) => `callcenter:${callCenterId}:queue:${queueId}`;
const getAgentKey = (callCenterId, agentId) => `callcenter:${callCenterId}:agent:${agentId}`;
const getQueueLoggedInAgentsKey = (callCenterId, queueId) => `callcenter:${callCenterId}:queue:${queueId}:agents_loggedIn`;
const getMasterQueuesKey = (callCenterId) => `callcenter:${callCenterId}:queues_master`;
const getMasterAgentsKey = (callCenterId) => `callcenter:${callCenterId}:agents_master`;
const getQueueCallsKey = (callCenterId, queueId) => `callcenter:${callCenterId}:queue:${queueId}:calls`;
const getQueueLastAgentRRKey = (callCenterId, queueId) => `callcenter:${callCenterId}:queue:${queueId}:lastAgentRR`;

// Queue Management Functions

/**
 * Creates a new queue.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} queueId - The ID of the queue.
 * @param {string} name - The name of the queue.
 * @param {string} strategy - The call distribution strategy (e.g., 'ringall', 'roundrobin').
 * @param {object} timings - Queue operational timings.
 * @returns {object} - Success status or queue details.
 */
async function createQueue(callCenterId, queueId, name, strategy, timings) {
  if (!callCenterId || !queueId) {
    return { success: false, error: 'callCenterId and queueId are required.' };
  }
  try {
    const queueKey = getQueueKey(callCenterId, queueId);
    const masterKey = getMasterQueuesKey(callCenterId);

    await redisClient.hmset(queueKey, {
      name,
      strategy,
      timings: JSON.stringify(timings), // Store timings as a JSON string
      status: 'CLOSED', // Default status
    });
    await redisClient.sadd(masterKey, queueId);
    console.log(`Queue ${queueId} created successfully for call center ${callCenterId}.`);
    return { success: true, data: { queueId, name, strategy, timings, status: 'CLOSED' } };
  } catch (error) {
    console.error(`Error creating queue ${queueId} for call center ${callCenterId}:`, error);
    return { success: false, error: 'Failed to create queue.' };
  }
}

/**
 * Gets details for a specific queue.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} queueId - The ID of the queue.
 * @returns {object|null} - Queue details or null if not found.
 */
async function getQueueDetails(callCenterId, queueId) {
  if (!callCenterId || !queueId) {
    return { success: false, error: 'callCenterId and queueId are required.' };
  }
  try {
    const queueKey = getQueueKey(callCenterId, queueId);
    const details = await redisClient.hgetall(queueKey);
    if (Object.keys(details).length === 0) {
      return { success: false, error: 'Queue not found.' };
    }
    // Parse timings back to an object
    if (details.timings) {
      details.timings = JSON.parse(details.timings);
    }
    return { success: true, data: details };
  } catch (error) {
    console.error(`Error fetching queue details for ${queueId} in call center ${callCenterId}:`, error);
    return { success: false, error: 'Failed to get queue details.' };
  }
}


// Agent Management Functions

/**
 * Adds a new agent.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} agentId - The ID of the agent.
 * @param {string} name - The name of the agent.
 * @param {string} endpoint - The agent's endpoint (e.g., PJSIP/agent101).
 * @param {object} shiftTimings - Agent's shift timings.
 * @returns {object} - Success status or agent details.
 */
async function addAgent(callCenterId, agentId, name, endpoint, shiftTimings) {
  if (!callCenterId || !agentId || !name || !endpoint) {
    return { success: false, error: 'callCenterId, agentId, name, and endpoint are required.' };
  }
  try {
    const agentKey = getAgentKey(callCenterId, agentId);
    const masterKey = getMasterAgentsKey(callCenterId);

    const agentData = {
      name,
      endpoint, // Added endpoint
      shiftTimings: JSON.stringify(shiftTimings),
      status: 'LOGGED_OUT',
      loggedInQueues: '[]',
    };

    await redisClient.hmset(agentKey, agentData);
    await redisClient.sadd(masterKey, agentId);
    console.log(`Agent ${agentId} (${endpoint}) added successfully for call center ${callCenterId}.`);
    return { success: true, data: { agentId, ...agentData, shiftTimings, loggedInQueues: [] } }; // Return full data including parsed shiftTimings
  } catch (error) {
    console.error(`Error adding agent ${agentId} for call center ${callCenterId}:`, error);
    return { success: false, error: 'Failed to add agent.' };
  }
}

/**
 * Gets details for a specific agent.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} agentId - The ID of the agent.
 * @returns {object|null} - Agent details or null if not found.
 */
async function getAgentDetails(callCenterId, agentId) {
  if (!callCenterId || !agentId) {
    return { success: false, error: 'callCenterId and agentId are required.' };
  }
  try {
    const agentKey = getAgentKey(callCenterId, agentId);
    const details = await redisClient.hgetall(agentKey);
    if (Object.keys(details).length === 0) {
      return { success: false, error: 'Agent not found.' };
    }
    // Parse shiftTimings and loggedInQueues back to objects/arrays
    if (details.shiftTimings) {
      details.shiftTimings = JSON.parse(details.shiftTimings);
    }
    if (details.loggedInQueues) {
      details.loggedInQueues = JSON.parse(details.loggedInQueues);
    }
    return { success: true, data: details };
  } catch (error) {
    console.error(`Error fetching agent details for ${agentId} in call center ${callCenterId}:`, error);
    return { success: false, error: 'Failed to get agent details.' };
  }
}


// Agent Login/Logout Functions

/**
 * Logs an agent into specified queues.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} agentId - The ID of the agent.
 * @param {string[]} queueIds - Array of queue IDs to log into.
 * @param {boolean} [forceLogin=false] - If true, bypasses shift check.
 * @returns {object} - Success status.
 */
async function agentLogin(callCenterId, agentId, queueIds, forceLogin = false) {
  if (!callCenterId || !agentId || !Array.isArray(queueIds)) {
    return { success: false, error: 'callCenterId, agentId, and a valid queueIds array are required.' };
  }

  try {
    const agentDetailsResult = await getAgentDetails(callCenterId, agentId); // Use existing function to get parsed details
    if (!agentDetailsResult.success || !agentDetailsResult.data) {
      return { success: false, error: 'Agent not found.' };
    }
    const agentDetails = agentDetailsResult.data;

    if (agentDetails.status !== 'LOGGED_OUT') {
      return { success: false, error: `Agent is already logged in or in status: ${agentDetails.status}.` };
    }

    if (!forceLogin) {
      const shiftCheckResult = await isAgentOnShift(callCenterId, agentId, new Date());
      if (!shiftCheckResult.success || !shiftCheckResult.data.isOnShift) {
        console.log(`Agent ${agentId} login attempt failed: Not on shift and not a forced login.`);
        return { success: false, error: 'Agent is not on shift.' };
      }
      console.log(`Agent ${agentId} is on shift. Proceeding with login.`);
    } else {
      console.log(`Agent ${agentId} login is forced, bypassing shift check.`);
    }

    const agentKey = getAgentKey(callCenterId, agentId); // We still need the key for hmset
    await redisClient.hmset(agentKey, {
      status: 'AVAILABLE',
      loggedInQueues: JSON.stringify(queueIds),
    });

    for (const queueId of queueIds) {
      const loggedInAgentsKey = getQueueLoggedInAgentsKey(callCenterId, queueId);
      await redisClient.sadd(loggedInAgentsKey, agentId);
    }

    console.log(`Agent ${agentId} logged into queues: ${queueIds.join(', ')} for call center ${callCenterId}.`);
    return { success: true };
  } catch (error) {
    console.error(`Error during agent login for ${agentId} in call center ${callCenterId}:`, error);
    return { success: false, error: 'Agent login failed.' };
  }
}

/**
 * Logs an agent out from all queues.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} agentId - The ID of the agent.
 * @returns {object} - Success status.
 */
async function agentLogout(callCenterId, agentId) {
  if (!callCenterId || !agentId) {
    return { success: false, error: 'callCenterId and agentId are required.' };
  }

  try {
    const agentKey = getAgentKey(callCenterId, agentId);
    const agentDetails = await redisClient.hgetall(agentKey);

    if (Object.keys(agentDetails).length === 0) {
      return { success: false, error: 'Agent not found.' };
    }
    if (agentDetails.status === 'LOGGED_OUT') {
      return { success: false, error: 'Agent is already logged out.' };
    }

    const loggedInQueues = JSON.parse(agentDetails.loggedInQueues || '[]');

    for (const queueId of loggedInQueues) {
      const loggedInAgentsKey = getQueueLoggedInAgentsKey(callCenterId, queueId);
      await redisClient.srem(loggedInAgentsKey, agentId);
    }

    await redisClient.hmset(agentKey, {
      status: 'LOGGED_OUT',
      loggedInQueues: '[]',
    });

    console.log(`Agent ${agentId} logged out from all queues for call center ${callCenterId}.`);
    return { success: true };
  } catch (error) {
    console.error(`Error during agent logout for ${agentId} in call center ${callCenterId}:`, error);
    return { success: false, error: 'Agent logout failed.' };
  }
}


module.exports = {
  createQueue,
  getQueueDetails,
  addAgent,
  getAgentDetails,
  agentLogin,
  agentLogout,
  addCallToQueue,
  removeCallFromQueue,
  getNextCallFromQueue,
  findAgentForCall_RoundRobin,
  isQueueActive,
  isAgentOnShift,
  findAgentForCall_RoundRobin, // Ensure it's exported
};

// Call Management Functions (assuming these are already here and correct)
// async function addCallToQueue(...) { ... }
// async function removeCallFromQueue(...) { ... }
// async function getNextCallFromQueue(...) { ... }


// Timing and Shift Management (assuming these are already here and correct)
// async function isQueueActive(...) { ... }
// async function isAgentOnShift(...) { ... }


// Agent Selection Strategies

/**
 * Finds an available agent for a call using Round Robin strategy.
 * @param {string} callCenterId - The ID of the call center.
 * @param {string} queueId - The ID of the queue.
 * @returns {object} - Success status and data (agentId or null if no agent available).
 */
async function findAgentForCall_RoundRobin(callCenterId, queueId) {
  if (!callCenterId || !queueId) {
    return { success: false, error: 'callCenterId and queueId are required.' };
  }

  const loggedInAgentsKey = getQueueLoggedInAgentsKey(callCenterId, queueId);
  const lastAgentRRKey = getQueueLastAgentRRKey(callCenterId, queueId);

  try {
    const loggedInAgents = await redisClient.smembers(loggedInAgentsKey);

    if (!loggedInAgents || loggedInAgents.length === 0) {
      console.log(`RoundRobin: No agents logged into queue ${queueId} for call center ${callCenterId}.`);
      return { success: true, data: null };
    }

    const trulyAvailableAgents = [];
    const currentTime = new Date(); // For shift check

    for (const agentId of loggedInAgents) {
      const agentDetailsResult = await getAgentDetails(callCenterId, agentId);
      if (agentDetailsResult.success && agentDetailsResult.data && agentDetailsResult.data.status === 'AVAILABLE') {
        // Check if agent is on shift
        const onShiftResult = await isAgentOnShift(callCenterId, agentId, currentTime);
        if (onShiftResult.success && onShiftResult.data.isOnShift) {
          trulyAvailableAgents.push(agentId);
        } else {
          console.log(`RoundRobin: Agent ${agentId} is logged in and AVAILABLE but not on shift. Skipping.`);
        }
      }
    }

    if (trulyAvailableAgents.length === 0) {
      console.log(`RoundRobin: No agents currently AVAILABLE and ON SHIFT in queue ${queueId} for call center ${callCenterId}. LoggedIn: ${loggedInAgents.join(',')}`);
      return { success: true, data: null };
    }
    
    trulyAvailableAgents.sort(); // Ensure consistent ordering

    const lastAgentId = await redisClient.get(lastAgentRRKey);
    let selectedAgentId = null;

    if (lastAgentId && trulyAvailableAgents.includes(lastAgentId)) {
      const lastIndex = trulyAvailableAgents.indexOf(lastAgentId);
      selectedAgentId = trulyAvailableAgents[(lastIndex + 1) % trulyAvailableAgents.length];
    } else {
      selectedAgentId = trulyAvailableAgents[0];
    }

    if (selectedAgentId) {
      await redisClient.set(lastAgentRRKey, selectedAgentId);
      console.log(`RoundRobin: Selected agent ${selectedAgentId} for queue ${queueId} in call center ${callCenterId}. Last was ${lastAgentId || 'N/A'}. Truly Available: ${trulyAvailableAgents.join(',')}`);
      return { success: true, data: { agentId: selectedAgentId } };
    } else {
      console.log(`RoundRobin: Could not select an agent for queue ${queueId} in call center ${callCenterId}, though truly available agents list was populated.`);
      return { success: true, data: null };
    }

  } catch (error) {
    console.error(`RoundRobin: Error finding agent for queue ${queueId} in call center ${callCenterId}:`, error);
    return { success: false, error: 'Failed to find agent using Round Robin.' };
  }
}
