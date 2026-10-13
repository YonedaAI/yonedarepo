const form = document.querySelector('#registration');
const status = document.querySelector('#status');
const cancel = document.querySelector('#cancel');
let registration = null;
async function request(path, body) {
  const response = await fetch(path, body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {});
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
async function refresh() {
  const {events} = await request('/api/events');
  const cards = document.querySelector('#events'); cards.replaceChildren();
  const select = form.elements.event; select.replaceChildren();
  for (const event of events) {
    const text = document.createElement('p'); text.textContent = `${event.title}: ${event.confirmed}/${event.capacity} booked, ${event.waitlisted} waiting`;
    cards.append(text); const option = document.createElement('option'); option.value=event.id;option.textContent=event.title;select.append(option);
  }
}
function show(row) {
  registration=row; cancel.hidden=row.status==='cancelled';
  status.textContent=row.status==='waitlisted' ? `Waitlisted at position ${row.position}.` : `Registration ${row.status} locally.`;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); form.querySelector('button').disabled=true;
  try { show((await request(`/api/events/${form.elements.event.value}/registrations`,
    {name:form.elements.name.value,email:form.elements.email.value,idempotency_key:crypto.randomUUID()})).registration); await refresh(); }
  catch (error) { status.textContent=`Could not register: ${error.message}`; }
  finally { form.querySelector('button').disabled=false; }
});
cancel.addEventListener('click', async () => {
  try { show((await request(`/api/registrations/${registration.id}/cancel`, {})).registration);await refresh(); }
  catch (error) { status.textContent=`Could not cancel: ${error.message}`; }
});
refresh().catch(() => { document.querySelector('#events').textContent='Events unavailable. Please reload.'; });
