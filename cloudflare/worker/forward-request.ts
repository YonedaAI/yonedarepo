// A service binding may answer without reading all of an upload (a bodyless command or an
// auth refusal). Its upload pump must stop before this Worker's response finishes: workerd
// invalidates the incoming request stream then. Keep streaming, including duplex responses,
// without buffering a Git push or waiting for an unwanted upload to finish.

export async function forwardRequest(service: Fetcher, req: Request): Promise<Response> {
  if (!req.body) return service.fetch(req);
  if (req.method === 'GET' || req.method === 'HEAD') {
    // A network client can attach bytes to a read, but Fetch forbids constructing such a
    // Request with a replacement body. Our read routes use the URL, never that input.
    await req.body.cancel().catch(() => undefined);
    return service.fetch(new Request(req, { body: null, cf: req.cf }));
  }
  const input = req.body.getReader();
  let stopped: Promise<void> | undefined;
  const stop = (reason?: unknown) => (stopped ??= input.cancel(reason).catch(() => undefined));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await input.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: stop,
  });
  let response: Response;
  try {
    response = await service.fetch(new Request(req, { body, cf: req.cf }));
  } catch (e) {
    await stop(e);
    throw e;
  }
  if (!response.body) {
    await stop();
    return response;
  }
  const output = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await output.read();
          if (next.done) {
            await stop();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (e) {
          await stop(e);
          controller.error(e);
        }
      },
      async cancel(reason) {
        await Promise.allSettled([stop(reason), output.cancel(reason)]);
      },
    }),
    response,
  );
}
