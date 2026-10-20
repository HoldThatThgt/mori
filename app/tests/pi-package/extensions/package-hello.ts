// synthetic: part of tests/pi-package (Mori UI tests); registers package_hello.
export default function (pi) {
  pi.registerTool({
    name: 'package_hello',
    label: 'Package hello',
    description: 'Says hello from the synthetic test package.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'hello from package' }], details: {} };
    },
  });
}
