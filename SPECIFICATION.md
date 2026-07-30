# Time Card Specification

## Locked requirements

- Weekly time cards run Sunday through Saturday.
- The first launch creates an administrator using an admin name and a 6-digit PIN.
- The login screen shows employee names; selecting a name opens a PIN prompt.
- Administrator and employee permissions are separate.
- Administrators can add, edit, and permanently remove employees.
- Employee fields include name, phone number, hourly pay rate, and PIN.
- Administrators can add, rename, and remove unused jobs.
- Employees enter hours by day and job, with an optional work note.
- An entry can be flagged only when a reason is supplied.
- Administrators can add and save a resolution comment and resolved status.
- Paid status is visible and editable from employee and administrator views.
- The administrator dashboard displays weekly hours, hourly rate, and check amount.
- Data must survive refreshes, sign-outs, device changes, and deployments.
- The interface must work on iPhone and desktop browsers.

## Data and security

- Records are stored in the hosted database, not browser storage.
- PINs are salted and hashed; plaintext PINs are never saved.
- Login sessions use secure, HTTP-only cookies.
- Removing an employee also removes that employee’s time entries and pay-week records.
- A job with existing time entries cannot be removed, preserving payroll history.
