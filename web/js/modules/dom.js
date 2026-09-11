export const dom = {
  // TOP BAR
  theme_text: document.getElementById('theme-text'),
  about_text: document.getElementById('about-text'),

  // ABOUT
  about_div: document.getElementById('about-div'),
  comic_img: document.getElementById('comic-img'),

  // ERROR
  error_div: document.getElementById('error-div'),
  error_message: document.getElementById('error-message'),

  // PASSWORD
  password_div: document.getElementById('password-div'),
  password_alert: document.getElementById('password-alert'),
  password_input: document.getElementById('password-input'),
  password_hide: document.getElementById('password-hide'),
  password_show: document.getElementById('password-show'),
  password_error: document.getElementById('password-error'),
  password_submit: document.getElementById('password-submit'),
  password_loading: document.getElementById('password-loading'),

  // CONNECT
  connect_div: document.getElementById('connect-div'),

  // TRANSFER
  transfer_div: document.getElementById('transfer-div'),

  transfer_qr_code: document.getElementById('transfer-qr-code'),
  transfer_status_protected: document.getElementById('transfer-status-protected'),
  transfer_status_wait: document.getElementById('transfer-status-wait'),
  transfer_status_success: document.getElementById('transfer-status-success'),

  transfer_url_value: document.getElementById('transfer-url-value'),
  transfer_url_copy: document.getElementById('transfer-url-copy'),
  transfer_url_success: document.getElementById('transfer-url-success'),

  transfer_select_file: document.getElementById('transfer-select-file'),
  transfer_select_file_input: document.getElementById('transfer-select-file-input'),
  transfer_add_password: document.getElementById('transfer-add-password'),

  transfer_users_div: document.getElementById('transfer-users-div'),
  transfer_users_count: document.getElementById('transfer-users-count'),
  transfer_users_list: document.getElementById('transfer-users-list'),
  transfer_users_list_host: document.getElementById('transfer-users-list-host'),
  transfer_users_list_host_name: document.getElementById('transfer-users-list-host-name'),

  transfer_files_div: document.getElementById('transfer-files-div'),
  transfer_files_count: document.getElementById('transfer-files-count'),
  transfer_files_download: document.getElementById('transfer-files-download'),
  transfer_files_list: document.getElementById('transfer-files-list'),
  transfer_files_list_empty: document.getElementById('transfer-files-list-empty'),

  // PASSWORD MODAL
  password_modal: document.getElementById('password-modal'),
  password_modal_value: document.getElementById('password-modal-value'),

  // NAME MODAL
  name_modal: document.getElementById('name-modal'),
  name_modal_value: document.getElementById('name-modal-value'),

  // FILE MODAL
  file_modal: document.getElementById('file-modal'),
  file_modal_table: document.getElementById('file-modal-table'),
  file_modal_table_empty: document.getElementById('file-modal-table-empty'),
  file_modal_refresh: document.getElementById('file-modal-refresh'),

  // DOWNLOAD MODAL
  download_modal: document.getElementById('download-modal'),
  download_modal_value: document.getElementById('download-modal-value'),
  download_modal_active: document.getElementById('download-modal-active'),
  download_modal_success: document.getElementById('download-modal-success'),
  download_modal_error: document.getElementById('download-modal-error'),
  download_modal_cancel: document.getElementById('download-modal-cancel'),
  download_modal_cancel_spinner: document.getElementById('download-modal-cancel-spinner'),
  download_modal_close: document.getElementById('download-modal-close'),

  // NOTIFICATION
  notification_modal: document.getElementById('notification-modal'),
  notification_modal_value: document.getElementById('notification-modal-value'),
}

// Display a confirmation dialog when the user attempts to refresh or navigate away from the page.
window.addEventListener("beforeunload", (event) => {
  // Safari (and older Chrome) only show the prompt when returnValue is set.
  event.preventDefault();
  event.returnValue = '';
});

// Toast notification
let _toastTimeout = null;
export function showToast(message, type = 'success') {
  const toast = document.getElementById('notification-toast')
  const toastValue = document.getElementById('notification-toast-value')
  const iconSuccess = document.getElementById('notification-toast-icon-success')
  const iconWarning = document.getElementById('notification-toast-icon-warning')
  if (!toast || !toastValue) return
  toastValue.textContent = message
  // Toggle icon based on type
  if (iconSuccess && iconWarning) {
    iconSuccess.style.display = type === 'warning' ? 'none' : 'inline'
    iconWarning.style.display = type === 'warning' ? 'inline' : 'none'
  }
  // Clear any existing timeout
  if (_toastTimeout) clearTimeout(_toastTimeout)
  // Show
  toast.style.opacity = '1'
  toast.style.transform = 'translateX(-50%) translateY(0)'
  // Auto-hide after 2s
  _toastTimeout = setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transform = 'translateX(-50%) translateY(-100px)'
  }, 2000)
}

// Focus the password input after the fade animation
dom.password_modal.addEventListener('shown.bs.modal', () => {
  dom.password_modal_value.focus()
});

// Focus the name input after the fade animation
dom.name_modal.addEventListener('shown.bs.modal', () => {
  dom.name_modal_value.focus()
});