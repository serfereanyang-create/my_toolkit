// Parse and inspect Server-Sent Events frames to detect early upstream errors.

/**
 * Parse a buffer containing one or more SSE frames.
 * Returns an array of parsed data objects (skips non-data events and empty lines).
 * Invalid JSON frames are skipped silently.
 */
export function parseSseFrames(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const frames = [];
  
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      frames.push({ type: 'done' });
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      frames.push({ type: 'data', data: parsed });
    } catch {
      // Malformed JSON; skip.
    }
  }
  
  return frames;
}

/**
 * Inspect buffered SSE frames to determine if the upstream returned an
 * immediate error without any real content.
 * 
 * Returns:
 * - { shouldRetry: true } if error detected and no content seen
 * - { shouldRetry: false, hasContent: true } if real content found
 * - { shouldRetry: false, hasContent: false } if inconclusive (keep buffering)
 */
export function inspectSseFrames(frames) {
  let hasError = false;
  let hasContent = false;
  
  for (const frame of frames) {
    if (frame.type === 'done') {
      // Reached [DONE] without content → this is an error-only stream.
      return { shouldRetry: hasError && !hasContent };
    }
    
    if (frame.type === 'data') {
      const obj = frame.data;
      
      // Check if this frame carries an error.
      if (obj.error && typeof obj.error.message === 'string') {
        hasError = true;
      }
      
      // Check if this frame carries real content.
      if (obj.delta || obj.message || obj.content || obj.output || obj.choices) {
        // Look deeper: choices/delta might be empty in the role-only first chunk.
        const deltaContent = obj.delta?.content || obj.delta?.tool_calls;
        const messageContent = obj.message?.content || obj.message?.tool_calls;
        const choicesContent = obj.choices?.some(c => 
          c.delta?.content || c.delta?.tool_calls || c.message?.content || c.message?.tool_calls
        );
        
        if (deltaContent || messageContent || choicesContent || obj.output) {
          hasContent = true;
        }
      }
    }
  }
  
  // If we've seen an error and no content, recommend retry.
  if (hasError && !hasContent) {
    return { shouldRetry: true };
  }
  
  // If we've seen content, commit to forwarding.
  if (hasContent) {
    return { shouldRetry: false, hasContent: true };
  }
  
  // Inconclusive; caller should keep buffering.
  return { shouldRetry: false, hasContent: false };
}
