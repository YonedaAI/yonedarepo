/** Starting points for an agent's instructions, recorded with the approved brief. */
export const approachPresets = [
  {
    id: 'minimal',
    label: 'Minimal and focused',
    instructions: 'Small, focused implementation with clear content',
  },
  {
    id: 'accessible',
    label: 'Accessibility first',
    instructions: 'Explore a different design with accessible interactions',
  },
  {
    id: 'visual',
    label: 'Bold visual design',
    instructions:
      'Build a distinctive visual design with strong typography and a cohesive visual system',
  },
  {
    id: 'content',
    label: 'Content and clarity',
    instructions:
      'Prioritize clear information architecture, useful copy, and straightforward navigation',
  },
  {
    id: 'interactive',
    label: 'Rich interactions',
    instructions:
      'Focus on useful interactive features, clear feedback, and complete user journeys',
  },
  {
    id: 'performance',
    label: 'Performance first',
    instructions:
      'Optimize fast loading and responsiveness with simple components and small dependencies',
  },
  {
    id: 'mobile',
    label: 'Mobile first',
    instructions:
      'Start with an excellent mobile experience and adapt the layout for larger screens',
  },
  {
    id: 'maintainable',
    label: 'Easy to maintain',
    instructions:
      'Favor modular components, predictable state, and a clean implementation that is easy to extend',
  },
];

export function nextApproach(used: string[]): string {
  return approachPresets.find((preset) => !used.includes(preset.instructions))?.instructions ?? '';
}
