import { describe, it, expect } from 'vitest';

describe('smoke', () => {
    it('jsdom provides document', () => {
        expect(document).toBeDefined();
        expect(document.createElement('div').tagName).toBe('DIV');
    });
});
