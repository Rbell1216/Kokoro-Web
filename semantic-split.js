// semantic-split.js - Enhanced intelligent text splitting for TTS processing

/**
 * Split text into semantically meaningful chunks for TTS processing
 * Uses paragraph → sentence → intelligent chunking approach
 * @param {string} text - The input text to split
 * @param {number} maxChunkLength - Maximum characters per chunk (default: 500)
 * @returns {string[]} Array of text chunks
 */
export function splitTextSmart(text, maxChunkLength = 500) {
  // Step 1: Split on paragraph boundaries (double newlines)
  const paragraphChunks = text.split(/\n\s*\n/);
  const finalChunks = [];

  for (let para of paragraphChunks) {
    if (para.length <= maxChunkLength) {
      // Paragraph fits in single chunk
      finalChunks.push(para.trim());
      continue;
    }

    // Step 2: Split paragraph on sentence boundaries
    const sentenceRegex = /(?<=[.?!])(?=\s+["'a-zA-Z])/gi;
    const sentences = para.split(sentenceRegex);

    let chunk = '';
    for (let sentence of sentences) {
      sentence = sentence.trim();

      // Handle sentences that are too long for any chunk
      if (sentence.length > maxChunkLength) {
        // Sentence too long — use fallback split
        const subChunks = splitLongSentence(sentence, maxChunkLength);
        for (let sub of subChunks) {
          if ((chunk + ' ' + sub).length > maxChunkLength) {
            if (chunk) finalChunks.push(chunk.trim());
            chunk = sub;
          } else {
            chunk += (chunk ? ' ' : '') + sub;
          }
        }
        continue;
      }

      // Check if adding this sentence would exceed the limit
      if ((chunk + ' ' + sentence).length > maxChunkLength) {
        if (chunk) finalChunks.push(chunk.trim());
        chunk = sentence;
      } else {
        chunk += (chunk ? ' ' : '') + sentence;
      }
    }
    
    // Add any remaining content in the current chunk
    if (chunk) finalChunks.push(chunk.trim());
  }

  return finalChunks;
}

/**
 * Handle splitting of extremely long sentences that exceed max chunk length
 * Uses comma → word → character fallback approach
 * @param {string} sentence - The long sentence to split
 * @param {number} maxLen - Maximum length for each chunk
 * @returns {string[]} Array of sentence chunks
 */
export function splitLongSentence(sentence, maxLen) {
  const chunks = [];
  let current = '';

  // Step 1: Try splitting on commas
  const commaParts = sentence.split(/,\s*/);
  for (let part of commaParts) {
    if ((current + ', ' + part).length > maxLen) {
      if (current) chunks.push(current.trim());
      
      if (part.length > maxLen) {
        // Part still too long - split on words
        const words = part.split(/\s+/);
        let wordChunk = '';
        for (let word of words) {
          if ((wordChunk + ' ' + word).length > maxLen) {
            if (wordChunk) chunks.push(wordChunk.trim());
            wordChunk = word;
          } else {
            wordChunk += (wordChunk ? ' ' : '') + word;
          }
        }
        if (wordChunk) chunks.push(wordChunk.trim());
        current = '';
      } else {
        current = part;
      }
    } else {
      current += (current ? ', ' : '') + part;
    }
  }
  
  if (current) chunks.push(current.trim());
  return chunks;
}

/**
 * Legacy text splitting function - kept for reference
 * Basic paragraph → sentence splitting without long sentence handling
 * @param {string} text - The input text to split
 * @param {number} maxChunkLength - Maximum characters per chunk (default: 500)
 * @returns {string[]} Array of text chunks
 */
function splitTextSmartOld(text, maxChunkLength = 500) {
  // Step 1: split on double newlines (paragraphs)
  const paragraphChunks = text.split(/\n\s*\n/);
  const finalChunks = [];

  for (let para of paragraphChunks) {
    if (para.length <= maxChunkLength) {
      finalChunks.push(para.trim());
      continue;
    }

    // Step 2: Further split on sentence boundaries if too long
    const sentenceRegex = /(?<=[.?!])(?=\s+["'a-zA-Z])/gi;
    const sentences = para.split(sentenceRegex);

    let chunk = '';
    for (let sentence of sentences) {
      sentence = sentence.trim();
      if ((chunk + ' ' + sentence).length > maxChunkLength) {
        if (chunk) finalChunks.push(chunk.trim());
        chunk = sentence;
      } else {
        chunk += (chunk ? ' ' : '') + sentence;
      }
    }
    if (chunk) finalChunks.push(chunk.trim());
  }

  return finalChunks;
}

/**
 * Alternative word-based splitting method
 * @param {string} text - The input text
 * @param {number} maxChunkLength - Maximum characters per chunk
 * @returns {string[]} Array of text chunks
 */
export function splitByWords(text, maxChunkLength = 300) {
  if (!text || text.length <= maxChunkLength) {
    return [text];
  }
  
  const words = text.split(/\s+/);
  const chunks = [];
  let currentChunk = '';
  
  for (const word of words) {
    if ((currentChunk + ' ' + word).length > maxChunkLength && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + word;
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/**
 * Get text statistics for optimization
 * @param {string} text - Input text
 * @returns {Object} Text statistics
 */
export function getTextStats(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const sentences = text.split(/(?<=[.?!])\s+/);
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  
  return {
    chars: text.length,
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgWordsPerSentence: words.length / Math.max(sentences.length, 1),
    avgCharsPerWord: text.length / Math.max(words.length, 1)
  };
}
