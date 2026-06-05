export default {
  async fetch(request, env) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Proxy any ClickUp API call
    // Frontend calls: /proxy/api/v2/space/123 → forwards to api.clickup.com/api/v2/space/123
    const url = new URL(request.url);
    const path = url.pathname.replace('/proxy', '');
    const search = url.search;

    const token = request.headers.get('Authorization');

    const upstream = await fetch('https://api.clickup.com' + path + search, {
      method: request.method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });

    const data = await upstream.text();

    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS,
      },
    });
  },
};
