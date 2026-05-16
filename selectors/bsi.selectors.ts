// ─────────────────────────────────────────────────────────────────────────────
// BSI Web App — Selector Reference
//
// These are the confirmed selectors from the Playwright codegen session.
// The automation engine (src/automation.ts) uses these patterns directly
// via page.getByRole() and page.locator() — this file is documentation only.
// ─────────────────────────────────────────────────────────────────────────────

// Login page
// page.getByRole('textbox', { name: 'Username' })
// page.getByRole('textbox', { name: 'Password' })
// page.getByRole('button',  { name: 'Sign In' })

// Navigation
// page.getByRole('link', { name: 'Work Orders' })
// page.getByRole('link', { name: ' Work Orders List' })
// page.locator(`#row_${workOrderId}`).getByRole('button', { name: 'View', exact: true })
//   → opens popup (page.waitForEvent('popup'))

// Ladder fields (all in the popup page)
// page.getByRole('textbox', { name: 'Serial Number' })
//   → fill → press Enter → wait for autocomplete
//   → press ArrowDown → button{name: serialNum}.press('Enter')  [existing serial]
//   → OR: button{name: 'No result, add serial number'}.click()  [new serial]
// page.getByRole('textbox', { name: 'Truck or Location ID' })
// page.locator('#LadderBrand')   selectOption by label text
// page.locator('#WoLadType')     selectOption by label text
// page.locator('#LadderLength')  selectOption by label text
// page.locator('#WoLadDesc')     selectOption by label text  (optional)

// Box management
// page.getByRole('button', { name: 'Add Box' })
// page.locator('#box-N')  — where N is the box number (1, 2, 3 ...)
// page.locator('#box-N').getByRole('button', { name: 'Add Product' })

// Parts dialog
// page.getByRole('textbox', { name: 'Search for ID / Type / Part' })
// page.locator('#ResPno')   — <select> populated after typing search term
// page.getByRole('textbox', { name: '1', exact: true })  — quantity field
// page.getByRole('button',  { name: 'Add Another' })     — add next part
// page.getByRole('button',  { name: 'Add & Close' })     — finish parts for this box

export {};
