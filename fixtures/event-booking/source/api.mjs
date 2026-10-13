export async function api(request, booking) {
  const {pathname} = new URL(request.url);
  try {
    if (request.method === 'GET' && pathname === '/health') return Response.json({status:'ok'});
    if (request.method === 'GET' && pathname === '/api/events') return Response.json({events:booking.events()});
    const registration = pathname.match(/^\/api\/registrations\/(\d+)(\/cancel)?$/);
    if (registration) {
      const id = Number(registration[1]);
      if (!Number.isSafeInteger(id) || id < 1) return Response.json({error:'invalid_id'}, {status:400});
      if (request.method === 'GET' && !registration[2]) return Response.json({registration:booking.registration(id)});
      if (request.method === 'POST' && registration[2]) return Response.json({registration:booking.cancel(id)});
    }
    const event = pathname.match(/^\/api\/events\/([a-z0-9-]+)\/registrations$/);
    if (event && request.method === 'POST') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 16_384) return Response.json({error:'body_too_large'}, {status:413});
      let input; try { input = JSON.parse(text); } catch { return Response.json({error:'invalid_json'}, {status:400}); }
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
      const key = input?.idempotency_key;
      if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
        || typeof key !== 'string' || !key || key.length > 120) return Response.json({error:'invalid_registration'}, {status:400});
      const result = booking.register(event[1], {name,email}, key);
      return Response.json(result, {status:result.created ? 201 : 200});
    }
    return Response.json({error:'not_found'}, {status:404});
  } catch (error) {
    return Response.json({error:error.status ? error.message : 'internal_error'}, {status:error.status ?? 500});
  }
}
