# Pi

On Nativai control pods, Pi uses the installed adapter at
`/opt/pi-acp/dist/index.js`. That launch remains allowed from `/workspace` and
`/wisdom`.

If the installed adapter is missing, the registry selects an npx fallback before
launch planning. Control pods refuse that fallback from shared directories.
Install the adapter into the control runtime, or run it in a workbench.
The guard checks both the configured command and the final resolved launch.
