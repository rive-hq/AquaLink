# Aqualink 2.7.1

- ignore message errors on shouldDeleteMessage
- Removed fs-extra usage, switch to fs/promises
- Fixed player breaking if no track given on autoResume
- Fixed an circular buffer cache related to user handling on autoResume / player saving
- Optimized node, made message handling faster, improved events binding efficiency, and other misc improviments.
  - This also improves the voice / audio stability, since its better for handling it.

## Breaking change

renamed the 'nodeConnect' event to 'nodeReady'
