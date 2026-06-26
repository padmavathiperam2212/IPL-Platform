export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pdfBase64, stage } = req.body;
  if (!pdfBase64 || !stage) {
    return res.status(400).json({ error: 'Missing pdfBase64 or stage' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const prompt = `Extract all cricket match fixtures from this IPL schedule PDF.
Return ONLY a valid JSON array, no markdown, no explanation.
Each object must have: match_no (integer), date (YYYY-MM-DD), scheduled_time (HH:MM 24h), team_a (home team full name), team_b (away team full name).
Return ONLY the JSON array starting with [ and ending with ].`;

  // Try multiple models in order of preference
  const models = [
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash'
  ];

  let lastError = null;

  for (const model of models) {
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
              { text: prompt }
            ]}],
            generationConfig: { temperature: 0 }
          })
        }
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        lastError = `Model ${model} failed with ${geminiRes.status}: ${errText}`;
        console.error(lastError);
        continue; // try next model
      }

      const geminiData = await geminiRes.json();
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        lastError = `Empty response from model ${model}`;
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      } catch (e) {
        lastError = `Non-JSON from model ${model}: ${rawText.substring(0, 200)}`;
        continue;
      }

      if (!Array.isArray(parsed)) {
        lastError = `Not an array from model ${model}`;
        continue;
      }

      const fixtures = parsed.map(m => ({
        id: `pdf_${stage}_m${m.match_no}`,
        date: m.date,
        scheduled_time: m.scheduled_time,
        team_a: m.team_a,
        team_b: m.team_b,
        stage: stage,
        result: null
      }));

      return res.status(200).json({ fixtures, model_used: model });

    } catch (err) {
      lastError = `Exception with model ${model}: ${err.message}`;
      continue;
    }
  }

  // All models failed
  return res.status(502).json({ error: lastError || 'All Gemini models failed' });
}
