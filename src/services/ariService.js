const ari = require('ari-client');
const config = require('../config');
const queueService = require('./queueService'); 

let ariClient; // Will be set in startService

function registerEventHandlers(client) {
  client.on('StasisStart', async (event, channel) => {
    console.log(`StasisStart: Channel ${channel.id} entered ${config.asterisk.ari_appName}. Caller: ${channel.caller.number}, DNID: ${channel.dialplan.exten}`);

    // Answer the call first
    if (channel.state === 'Ringing') {
      try {
        await channel.answer();
        console.log(`Call ${channel.id} answered.`);
      } catch (err) {
        console.error(`Error answering call ${channel.id}:`, err);
        channel.hangup().catch(e => console.error(`Error hanging up unanswered call ${channel.id}`, e));
        return;
      }
    } else {
      console.log(`Channel ${channel.id} is not in 'Ringing' state (state: ${channel.state}). Proceeding with existing state.`);
    }

    // Extract callCenterId and queueId from channel variables
    const callCenterId = channel.dialplan.CALL_CENTER_ID;
    const queueId = channel.dialplan.QUEUE_ID;

    if (!callCenterId || !queueId) {
      console.error(`Channel ${channel.id}: Missing CALL_CENTER_ID (${callCenterId}) or QUEUE_ID (${queueId}). Hanging up.`);
      channel.hangup().catch(e => console.error(`Error hanging up call ${channel.id} with missing vars`, e));
      return;
    }
    console.log(`Channel ${channel.id}: CallCenterID=${callCenterId}, QueueID=${queueId}`);

    // Check if queue is active
    const queueActiveResult = await queueService.isQueueActive(callCenterId, queueId, new Date());
    if (!queueActiveResult.success || !queueActiveResult.data.isActive) {
      console.log(`Channel ${channel.id}: Queue ${queueId} for call center ${callCenterId} is currently closed. Playing no service message and hanging up.`);
      try {
        // Ensure channel is not already hung up
        if (channel.state !== 'Hangup') {
          await channel.play({ media: 'sound:ss-noservice' }); // Ensure this sound file exists on Asterisk
          if (channel.state !== 'Hangup') { // Check again before hangup
             await channel.hangup();
          }
        }
      } catch (playError) {
        console.error(`Channel ${channel.id}: Error playing 'no service' message or hanging up:`, playError);
        // If playing fails, still attempt to hang up if channel is not already hung up
        if (channel.state !== 'Hangup') {
            channel.hangup().catch(e => console.error(`Error hanging up call ${channel.id} after play error`, e));
        }
      }
      return; // Stop further processing
    }
    console.log(`Channel ${channel.id}: Queue ${queueId} is active. Proceeding with call handling.`);


    const queueDetailsResult = await queueService.getQueueDetails(callCenterId, queueId);

    if (!queueDetailsResult.success || !queueDetailsResult.data) {
      console.error(`Channel ${channel.id}: Queue ${queueId} for call center ${callCenterId} not found or error fetching (after active check). Hanging up.`);
      channel.hangup().catch(e => console.error(`Error hanging up call ${channel.id} for non-existent queue`, e));
      return;
    }

    const queueStrategy = queueDetailsResult.data.strategy;
    console.log(`Channel ${channel.id}: Queue strategy is ${queueStrategy}.`);

    if (queueStrategy === 'ROUND_ROBIN') {
      const agentResult = await queueService.findAgentForCall_RoundRobin(callCenterId, queueId);

      if (agentResult.success && agentResult.data && agentResult.data.agentId) {
        const agentId = agentResult.data.agentId;
        console.log(`Channel ${channel.id}: Found agent ${agentId} for queue ${queueId} using Round Robin.`);

        const agentDetailsResult = await queueService.getAgentDetails(callCenterId, agentId);
        if (!agentDetailsResult.success || !agentDetailsResult.data || !agentDetailsResult.data.endpoint) {
          console.error(`Channel ${channel.id}: Could not get details or endpoint for agent ${agentId}. Re-queuing call.`);
          // Re-queue logic (simplified: add back to queue, play MOH)
          await queueService.addCallToQueue(callCenterId, queueId, { ariChannelId: channel.id, callerNumber: channel.caller.number, enqueueTime: Date.now() });
          channel.startMoh('default').catch(e => console.error(`Error starting MOH for ${channel.id}`, e));
          return;
        }
        
        const agentEndpoint = agentDetailsResult.data.endpoint;
        console.log(`Channel ${channel.id}: Attempting to originate call to agent ${agentId} at endpoint ${agentEndpoint}.`);

        // TODO: Set agent status to RINGING
        // await queueService.setAgentStatus(callCenterId, agentId, 'RINGING', channel.id);


        const agentChannel = client.Channel(); // Use the client passed to registerEventHandlers
        agentChannel.originate({
          endpoint: agentEndpoint,
          callerId: channel.caller.number, // Or a specific caller ID for internal calls
          app: config.asterisk.ari_appName,
          appArgs: 'dialed_agent', // Indicate this is an agent leg
          timeout: 15, // Timeout for agent to answer
        }, (err, dialedAgentChannel) => {
          if (err) {
            console.error(`Channel ${channel.id}: Error originating call to agent ${agentId} (${agentEndpoint}):`, err);
            // TODO: Re-queue the original call or handle error
            // TODO: Set agent status back to AVAILABLE
            // await queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
            console.log(`Channel ${channel.id}: Adding call back to queue ${queueId} after origination failure.`);
            queueService.addCallToQueue(callCenterId, queueId, { ariChannelId: channel.id, callerNumber: channel.caller.number, enqueueTime: Date.now() })
              .then(() => channel.startMoh('default').catch(e => console.error(`Error starting MOH for ${channel.id} after origination fail`, e)))
              .catch(e => console.error(`Error adding call ${channel.id} to queue after origination fail`, e));
            return;
          }
          console.log(`Channel ${channel.id}: Call to agent ${agentId} (channel ${dialedAgentChannel.id}) initiated.`);

          dialedAgentChannel.once('StasisStart', (event, agentStasisChannel) => {
            console.log(`Channel ${channel.id}: Agent's channel ${agentStasisChannel.id} entered Stasis.`);
            agentStasisChannel.answer(async (answerErr) => {
              if (answerErr) {
                console.error(`Channel ${channel.id}: Error answering agent channel ${agentStasisChannel.id}:`, answerErr);
                channel.hangup().catch(e => console.error(`Error hanging up original call ${channel.id} after agent answer fail`, e));
                // TODO: Set agent status back to AVAILABLE
                // await queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
                return;
              }
              console.log(`Channel ${channel.id}: Agent ${agentId} answered (channel ${agentStasisChannel.id}). Creating bridge.`);
              const bridge = client.Bridge(); // Use the client passed to registerEventHandlers
              bridge.create({ type: 'mixing' }, async (createErr, newBridge) => {
                if (createErr) {
                  console.error(`Channel ${channel.id}: Error creating bridge:`, createErr);
                  channel.hangup().catch(e => console.error(`Error hanging up original call ${channel.id} after bridge create fail`, e));
                  agentStasisChannel.hangup().catch(e => console.error(`Error hanging up agent channel ${agentStasisChannel.id} after bridge create fail`, e));
                  // TODO: Set agent status back to AVAILABLE
                  // await queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
                  return;
                }
                console.log(`Channel ${channel.id}: Bridge ${newBridge.id} created. Adding channels.`);
                try {
                  await newBridge.addChannel({ channel: [channel.id, agentStasisChannel.id] });
                  console.log(`Channels ${channel.id} and ${agentStasisChannel.id} added to bridge ${newBridge.id}.`);
                  // TODO: Update agent status to ON_CALL in queueService
                  // await queueService.setAgentStatus(callCenterId, agentId, 'ON_CALL', channel.id);
                } catch (addChannelErr) {
                  console.error(`Channel ${channel.id}: Error adding channels to bridge ${newBridge.id}:`, addChannelErr);
                  channel.hangup().catch(e => console.error(`Error hanging up original call ${channel.id} after bridge add fail`, e));
                  agentStasisChannel.hangup().catch(e => console.error(`Error hanging up agent channel ${agentStasisChannel.id} after bridge add fail`, e));
                  newBridge.destroy().catch(e => console.error("Error destroying bridge", e));
                  // TODO: Set agent status back to AVAILABLE
                  // await queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
                }
              });
            });
          });
          
          dialedAgentChannel.once('ChannelDestroyed', (event) => {
            console.log(`Channel ${channel.id}: Agent channel ${dialedAgentChannel.id} destroyed.`);
            // If the original call (channel) is still up and not hung up (e.g. not bridged and agent hung up before answer)
            // it might need to be re-queued or hung up.
            // This area needs robust handling for call cleanup.
            // For now, if original channel is still 'Up', try to requeue.
            if (channel.state === 'Up') { // Check if original caller channel is still active
                console.log(`Channel ${channel.id}: Agent channel destroyed, original call still up. Attempting to requeue.`);
                // TODO: Set agent status back to AVAILABLE if not already handled by another event
                // await queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
                queueService.addCallToQueue(callCenterId, queueId, { ariChannelId: channel.id, callerNumber: channel.caller.number, enqueueTime: Date.now() })
                  .then(() => channel.startMoh('default').catch(e => console.error(`Error starting MOH for ${channel.id} after agent channel destroyed`, e)))
                  .catch(e => console.error(`Error adding call ${channel.id} to queue after agent channel destroyed`, e));
            }
          });
        });

      } else {
        console.log(`Channel ${channel.id}: No agent available for queue ${queueId} via Round Robin. Queuing call.`);
        await queueService.addCallToQueue(callCenterId, queueId, { ariChannelId: channel.id, callerNumber: channel.caller.number, enqueueTime: Date.now() });
        channel.startMoh('default').catch(e => console.error(`Error starting MOH for ${channel.id}`, e));
      }
    } else {
      // Handle other strategies or default behavior
      console.log(`Channel ${channel.id}: Queue strategy ${queueStrategy} not implemented or unknown. Hanging up.`);
      channel.hangup().catch(e => console.error(`Error hanging up call ${channel.id} for unimplemented strategy`, e));
    }
  });

  client.on('StasisEnd', async (event, channel) => { // Made async for potential queueService calls
    console.log(`StasisEnd: Channel ${channel.id} left ${config.asterisk.ari_appName}. State: ${channel.state}`);
    // If this channel was a caller in a queue, remove it.
    // This requires knowing if the channel was indeed queued.
    // We need to extract callCenterId and queueId, potentially from channel vars if they persist,
    // or by looking up the channel.id in a list of active queued calls.
    // For now, simple removal attempt.
    const callCenterId = channel.dialplan.CALL_CENTER_ID; // Might not be available if channel vars are cleared
    const queueId = channel.dialplan.QUEUE_ID; // Might not be available

    if (callCenterId && queueId) {
        // Check if the call was in the queue (e.g. caller hung up before being connected to agent)
        // This is a simplified check; a more robust way would be to check if this channel.id is in the Redis list
        // For now, we just try to remove. If it's not there, LREM does nothing.
        const removalResult = await queueService.removeCallFromQueue(callCenterId, queueId, channel.id);
        if (removalResult.success && removalResult.removedCount > 0) {
            console.log(`Channel ${channel.id} (caller) removed from queue ${queueId} on StasisEnd.`);
        }
    }
    // TODO: Add logic to update agent status if this channel was an agent's leg.
    // This would involve identifying if the channel.id belongs to an agent and then
    // using queueService.setAgentStatus(callCenterId, agentId, 'AVAILABLE');
    // or queueService.setAgentStatus(callCenterId, agentId, 'WRAPPING_UP', { duration: 30 });
  });

  client.on('WebSocketError', err => console.error('ARI WebSocket Error:', err));
  client.on('WebSocketClose', (code, reason) => console.log('ARI WebSocket Closed:', code, reason));
  client.on('WebSocketPong', () => console.log('ARI WebSocket Pong received'));
}

function onAriConnect(client) {
  console.log(`ARI Client connected. Application '${config.asterisk.ari_appName}' is ready.`);
  // Later, this function will be used to subscribe the application to Asterisk:
  // client.applications.subscribe({ applicationName: config.asterisk.ari_appName }, (err) => {
  //   if (err) {
  //     console.error(`Error subscribing application ${config.asterisk.ari_appName}:`, err);
  //     throw err; // Or handle more gracefully
  //   }
  //   console.log(`Application ${config.asterisk.ari_appName} subscribed successfully.`);
  // });
}

function connectAri() {
  const ariUrl = `http://${config.asterisk.ari_host}:${config.asterisk.ari_port}/ari`;
  console.log(`Attempting to connect to ARI at ${ariUrl} as ${config.asterisk.ari_username}`);

  ari.connect(ariUrl, config.asterisk.ari_username, config.asterisk.ari_password, (err, client) => {
    if (err) {
      console.error('ARI connection error:', err);
      // For critical failure, you might want to process.exit(1) or implement a retry mechanism
      throw err;
    }
    ariClient = client;
    console.log('ARI connection successful.');

    registerEventHandlers(ariClient);
    // onAriConnect will be called after app subscription in startService
  });
}

async function startService() {
  return new Promise((resolve, reject) => {
    const ariUrl = `http://${config.asterisk.ari_host}:${config.asterisk.ari_port}/ari`;
    console.log(`Attempting to connect to ARI at ${ariUrl} as ${config.asterisk.ari_username}`);

    ari.connect(ariUrl, config.asterisk.ari_username, config.asterisk.ari_password, (err, client) => {
      if (err) {
        console.error('ARI connection error:', err);
        return reject(err); // Reject the promise on connection error
      }
      ariClient = client;
      console.log('ARI connection successful.');

      registerEventHandlers(ariClient);

      ariClient.on('ready', () => {
        // This 'ready' event is often emitted by the client library itself
        // once it's fully initialized and connected, after the initial callback.
        // It's a good place to subscribe to applications.
        ariClient.applications.subscribe({ applicationName: [config.asterisk.ari_appName] }, (subscribeErr) => {
          if (subscribeErr) {
            console.error(`Error subscribing application ${config.asterisk.ari_appName}:`, subscribeErr);
            return reject(subscribeErr); // Reject if subscription fails
          }
          console.log(`Application ${config.asterisk.ari_appName} subscribed successfully.`);
          onAriConnect(ariClient); // Call this after successful subscription
          
          // Start listening to events for the application
          ariClient.start(config.asterisk.ari_appName);
          console.log(`ARI application '${config.asterisk.ari_appName}' started and listening for events.`);
          resolve(ariClient); // Resolve the promise with the client
        });
      });

      // Handle cases where 'ready' might not be explicitly emitted or if we want to proceed
      // without it, though 'ready' or a similar mechanism is standard.
      // If 'ready' is not a standard event for this version of ari-client,
      // the logic above might need to be placed directly after registerEventHandlers
      // and before resolving the promise.
      // For now, assuming 'ready' or similar is available.
      // If not, the subscription can happen right after `registerEventHandlers`.
    });
  });
}

module.exports = {
  startService,
  // Potentially export ariClient if direct access is needed elsewhere,
  // but usually, service functions would abstract its use.
};
