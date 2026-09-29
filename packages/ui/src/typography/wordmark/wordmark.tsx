import { createUniqueId, type ComponentProps } from "solid-js"

export function Wordmark(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 414 126"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <path opacity="0.7" d="M72 18H18V108H72V18ZM90 126H0V0H90V126Z" fill="currentColor" />
            <path opacity="0.7" d="M198 18H126V108H198V126H108V0H198V18Z" fill="currentColor" />
            <path opacity="0.7" d="M270 18V54H306V72H270V108H252V72H216V54H252V18H270Z" fill="currentColor" />
            <path opacity="0.7" d="M378 18V54H414V72H378V108H360V72H324V54H360V18H378Z" fill="currentColor" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="414" height="126">
          <rect width="414" height="126" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="207" y1="66" x2="207" y2="126" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
