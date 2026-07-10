export default {
  async fetch(request, env) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace('/proxy', '');
    const search = url.search;
    const token = request.headers.get('Authorization');

    const upstream = await fetch('https://api.clickup.com' + path + search, {
      headers: { 'Authorization': token }
    });

    const data = await upstream.text();

    return new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};
