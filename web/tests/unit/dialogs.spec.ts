import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SecretDialog from '@/components/SecretDialog.vue';

describe('dangerous operation dialogs', () => {
  it('does not confirm until the explicit action button is clicked', async () => {
    const wrapper = mount(ConfirmDialog, { props: { open: true, title: '取消任务？', description: '不可撤销', dangerous: true }, attachTo: document.body });
    expect(wrapper.emitted('confirm')).toBeUndefined();
    const buttons = document.body.querySelectorAll('button');
    (buttons.item(buttons.length - 1) as HTMLButtonElement).click();
    await nextTick();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    wrapper.unmount();
  });

  it('renders a one-time secret only while open', async () => {
    const wrapper = mount(SecretDialog, { props: { open: true, secret: 'scan_one_time' }, attachTo: document.body });
    expect(document.body.textContent).toContain('scan_one_time');
    await wrapper.setProps({ open: false });
    expect(document.body.textContent).not.toContain('scan_one_time');
    wrapper.unmount();
  });

  it('closes the one-time secret immediately after a successful copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const wrapper = mount(SecretDialog, { props: { open: true, secret: 'scan_copy_once' }, attachTo: document.body });
    (document.body.querySelector('[aria-label="复制 Token（复制后关闭）"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('scan_copy_once');
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });
});
