export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pdfBase64, stage } = req.body;
  if (!pdfBase64 || !stage) {
    return res.status(400).json({ error: 'Missing pdfBase64 or stage in request body' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const prompt = `You are extracting cricket match fixtures from an IPL schedule PDF.

Extract all matches and return ONLY a valid JSON array — no markdown, no explanation, no backticks.

Each object must have exactly these fields:
- "match_no": integer (the match number)
- "date": string in YYYY-MM-DD format (e.g. "2026-03-28")
- "scheduled_time": string in HH:MM 24-hour format (e.g. "19:30")
- "team_a": string (home team full name, e.g. "Mumbai Indians")
- "team_b": string (away team full name, e.g. "Chennai Super Kings")

The Home column is team_a, the Away column is team_b. Do not swap them.
Return ONLY the JSON array starting with [ and ending with ].`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { temperature: 0 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      return res.status(502).json({ error: `Gemini API error: ${geminiRes.status}` });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      return res.status(502).json({ error: 'Empty response from Gemini' });
    }

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse Gemini response:', rawText);
      return res.status(502).json({ error: 'Gemini returned non-JSON response', raw: rawText });
    }

    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Gemini response was not an array' });
    }

    // Convert to app fixture format with deterministic IDs (idempotent re-imports)
    const fixtures = parsed.map(m => ({
      id: `pdf_${stage}_m${m.match_no}`,
      date: m.date,
      scheduled_time: m.scheduled_time,
      team_a: m.team_a,
      team_b: m.team_b,
      stage: stage,
      result: null
    }));

    return res.status(200).json({ fixtures });

  } catch (err) {
    console.error('Serverless function error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
