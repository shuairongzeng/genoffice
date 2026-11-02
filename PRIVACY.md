# GenOffice Privacy

Last updated: November 2, 2026

GenOffice opens, edits, and saves documents locally. Document editing does not
upload files to GenOffice. AI features require a network connection and send
requests only when you use them.

## AI requests

When you use an AI feature, the request sent to the configured AI provider
includes your prompt plus the context the answer needs. The AI panel's system
prompt carries a live "current surface" summary so answers can account for
what you are looking at: the titles of your open tabs, the file paths of open
documents, and the addresses of open browser tabs — the active browser tab's
full address, background browser tabs contribute only their site name. Files
you open with the AI panel's desktop tools are limited to the same scope the
knowledge base reads (starred, recent, knowledge-folder, and indexed files).
Avoiding the AI features keeps all of this on your machine.

## Usage analytics

Usage analytics is enabled by default in packaged official builds, including
the initial app launch before the onboarding notice is shown. Onboarding
explains what is collected and where to turn it off.

You can disable reporting at any time under **Settings → General → Send
anonymous usage statistics**. An explicit opt-out is remembered and stops all
subsequent analytics events.

### Events and parameters

When enabled, the app sends these events:

- `install_first_launch` — marks the first analytics-enabled use of a newly
  assigned anonymous `client_id`; used for retention cohorts
- `app_launch` — no event-specific parameter
- `file_open` — `ext`, the file extension such as `docx` or `xlsx`
- `file_new` — `kind`, one of `docx`, `xlsx`, `pptx`, `md`, or `pdf`
- `login_click` — no event-specific parameter
- `login_success` — no event-specific parameter

Every event includes:

- `app_version`
- `platform`
- `os_version`
- `ui_lang`
- a per-process `session_id` derived from the process start time
- `engagement_time_msec` with the fixed value `100`

When available, the payload also includes `country_id`, the two-letter country
code from the operating system's regional locale. This can differ from the
user's physical location.

The Google Analytics 4 payload also uses a random install UUID as `client_id`.
The country code is sent through GA4's country-only `user_location` field; the
app does not send a city or region. Neither identifier is a Genspark account or
email address.

## Network information

Events are sent to Google Analytics 4 using the Measurement Protocol over
HTTPS. As the HTTPS recipient, Google necessarily sees the connection's public
IP address and transport metadata, and may use them for coarse geolocation and
security or spam-abuse processing. GenOffice does not add an IP address to the
event payload.

## Data not collected by analytics

GenOffice analytics never sends:

- document content
- file names
- file paths
- Genspark account identity
- email addresses

The analytics metadata is injected only into packaged official builds and is
not part of this repository. Source builds and forks without that packaged
metadata install a no-op tracker and send no usage analytics; all features work
the same.
