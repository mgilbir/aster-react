/**
 * Vision reviewer: POST { image_base64, prompt } -> multimodal model analysis.
 * Tries llama-4-scout via the messages (image_url) API first — that shape is
 * what delivers the image — then falls back to other models/shapes.
 */
const MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.2-11b-vision-instruct']

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.searchParams.has('agree')) {
      const model = url.searchParams.get('agree')
      try {
        const r = await env.AI.run(model, { prompt: 'agree', max_tokens: 10 })
        return Response.json({ agreed: model, r })
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 })
      }
    }
    if (request.method !== 'POST') {
      return new Response('POST { image_base64, prompt }', { status: 405 })
    }
    const { image_base64, prompt } = await request.json()
    const text = typeof prompt === 'string' && prompt.length ? prompt : 'Describe this screenshot.'
    const attempted = []

    // llama-4-scout: messages API with the image as a data URI. This is the
    // shape that actually transmits the image to the model.
    try {
      const result = await env.AI.run(MODELS[0], {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image_base64}` } },
            ],
          },
        ],
        max_tokens: 900,
      })
      const description = typeof result === 'string' ? result : (result.description ?? result.response ?? JSON.stringify(result))
      return Response.json({ model: MODELS[0], shape: 'messages', text: description })
    } catch (e) {
      attempted.push(`${MODELS[0]} messages: ${e.message}`)
    }

    // llama-3.2 vision as a fallback (messages shape too).
    try {
      const result = await env.AI.run(MODELS[1], {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image_base64}` } },
            ],
          },
        ],
        max_tokens: 900,
      })
      const description = typeof result === 'string' ? result : (result.description ?? result.response ?? JSON.stringify(result))
      return Response.json({ model: MODELS[1], shape: 'messages', text: description })
    } catch (e) {
      attempted.push(`${MODELS[1]} messages: ${e.message}`)
    }

    return Response.json({ error: 'all models failed', attempted }, { status: 500 })
  },
}
