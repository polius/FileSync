// Apply the saved theme before first paint to avoid a flash. Runs from <head>.
// localStorage can throw in sandboxed contexts — fall back to the default (dark).
try {
  if (window.localStorage.getItem('mode') == 'light') {
    document.documentElement.classList.remove("dark")
    document.documentElement.classList.add("light")
    document.documentElement.setAttribute('data-bs-theme', 'light')
  }
  else {
    document.documentElement.classList.remove("light")
    document.documentElement.classList.add("dark")
    document.documentElement.setAttribute('data-bs-theme', 'dark')
  }
} catch {}
