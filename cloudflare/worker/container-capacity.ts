/** Only SDK errors proving that no process was allocated may refund a claim. */
export function capacityUnavailable(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes(
      'there is no container instance that can be provided to this durable object',
    ) ||
    message.startsWith('maximum number of running container instances exceeded.') ||
    message.includes('you are requesting too many containers per second')
  );
}
