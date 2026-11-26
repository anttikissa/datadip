// Web client entry point mounting DataDip with Solid 2.
import { render } from '@solidjs/web'
import { App } from './App.tsx'
import './styles.css'

render(() => <App />, document.getElementById('root')!)
